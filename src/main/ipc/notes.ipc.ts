import { ipcMain, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as notesRepo from '../database/repositories/notes.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import { getDatabase } from '../database/connection'
import { suggestNoteTag } from '../services/note-tagging.service'
import { hydrateCompanionNote } from './note-hydration'
import type { NoteCreateData, NoteFilterView, NoteUpdateData } from '../../shared/types/note'
import type { ImportFormat } from '../../shared/types/note'

// ---------------------------------------------------------------------------
// Import helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 // 2MB

/** Recursively collect all .txt/.md files under a folder */
export function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) files.push(...collectFiles(full))
    else if (/\.(txt|md)$/i.test(e.name)) files.push(full)
  }
  return files
}

/** Build display title from file path + root folder.
 *  If file is in a subfolder, prefix with immediate parent folder name.
 *  "rootFolder/Work/kick-off.md" → "Work — kick-off"
 *  "rootFolder/kick-off.md"      → "kick-off"
 */
export function buildTitleFromPath(filePath: string, rootFolder: string, format: ImportFormat): string {
  const rel = path.relative(rootFolder, filePath)
  const parts = rel.split(path.sep)
  const filename = path.basename(parts[parts.length - 1], path.extname(parts[parts.length - 1]))
  const cleaned = format === 'notion' ? stripNotionUUID(filename) : filename
  if (parts.length > 1) {
    const parent = parts[parts.length - 2]
    return `${parent} — ${cleaned}`
  }
  return cleaned
}

/** Strip Notion's trailing UUID from filenames.
 *  "Project Alpha abc123def456abc1" → "Project Alpha"
 */
export function stripNotionUUID(title: string): string {
  return title.replace(/\s+[0-9a-f]{20,32}$/i, '').trim()
}

/** Content fingerprint: first 200 chars of content (used for dedup) */
export function buildFingerprint(content: string): string {
  return content.substring(0, 200)
}

interface ProcessFileResult {
  title: string
  content: string
  fingerprint: string
  skip: boolean
  error?: string
}

/** Shared per-file logic used by both scan and import handlers.
 *  Returns skip=true for empty, too-large, or unreadable files.
 */
export function processFile(file: string, rootFolder: string, format: ImportFormat): ProcessFileResult {
  const stat = fs.statSync(file)
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return {
      title: '', content: '', fingerprint: '', skip: true,
      error: `${path.basename(file)}: file too large (>${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)`
    }
  }
  const content = fs.readFileSync(file, 'utf8').trim()
  if (!content) return { title: '', content: '', fingerprint: '', skip: true }
  const title = buildTitleFromPath(file, rootFolder, format)
  const fingerprint = buildFingerprint(content)
  return { title, content, fingerprint, skip: false }
}

// ---------------------------------------------------------------------------
// Import state (module-level, single import at a time)
// ---------------------------------------------------------------------------

const BATCH_SIZE = 20
let importAbortController: AbortController | null = null
let importInFlight = false

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

export function registerNotesHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.NOTES_LIST, (_event, filter?: NoteFilterView, query?: string) => {
    if (query?.trim()) return notesRepo.searchNotes(query.trim())
    return notesRepo.listNotes(filter)
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_GET, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const note = notesRepo.getNote(noteId)
    if (!note) return null
    return hydrateCompanionNote(note, getCurrentUserId())
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_CREATE, (_event, data: NoteCreateData) => {
    if (!data?.content?.trim() && !data?.title?.trim()) throw new Error('content is required')
    const userId = getCurrentUserId()
    const note = notesRepo.createNote(data, userId)
    if (note) {
      logAudit(userId, 'note', note.id, 'create', data)
    }
    return note
  })

  ipcMain.handle(
    IPC_CHANNELS.NOTES_UPDATE,
    (_event, noteId: string, updates: NoteUpdateData) => {
      if (!noteId) throw new Error('noteId is required')
      const userId = getCurrentUserId()
      const note = notesRepo.updateNote(noteId, updates || {}, userId)
      if (note) {
        logAudit(userId, 'note', noteId, 'update', updates || {})
      }
      return note
    }
  )

  ipcMain.handle(IPC_CHANNELS.NOTES_DELETE, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const userId = getCurrentUserId()
    const deleted = notesRepo.deleteNote(noteId)
    if (deleted) {
      logAudit(userId, 'note', noteId, 'delete', null)
    }
    return deleted
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_SUGGEST_TAG, async (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const note = notesRepo.getNote(noteId)
    if (!note) return null
    // Only suggest tags for notes that aren't already tagged
    if (note.companyId || note.contactId) return null
    return suggestNoteTag(note.content)
  })

  // ---------------------------------------------------------------------------
  // NOTES_IMPORT_SCAN — opens folder dialog, counts files, no writes
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.NOTES_IMPORT_SCAN, async (_event, format: ImportFormat) => {
    const result = await dialog.showOpenDialog({
      title: 'Select Notes Folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const folderPath = result.filePaths[0]
    const files = collectFiles(folderPath)
    const db = getDatabase()
    let alreadyExist = 0

    for (const file of files) {
      try {
        const pf = processFile(file, folderPath, format)
        if (pf.skip) continue
        const exists = db.prepare(
          'SELECT id FROM notes WHERE title = ? AND SUBSTR(content,1,200) = ? LIMIT 1'
        ).get(pf.title, pf.fingerprint)
        if (exists) alreadyExist++
      } catch { /* skip unreadable files in scan */ }
    }

    const folders = new Set(files.map(f => path.dirname(f))).size
    return { total: files.length, alreadyExist, folders, folderPath }
  })

  // ---------------------------------------------------------------------------
  // NOTES_IMPORT_FOLDER — batched write with live progress streaming
  // ---------------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.NOTES_IMPORT_FOLDER,
    async (event, folderPath: string, format: ImportFormat) => {
      if (importInFlight) throw new Error('Import already in progress')
      importAbortController = new AbortController()
      importInFlight = true

      const db = getDatabase()
      const userId = getCurrentUserId()
      const createdNoteIds: string[] = []
      let created = 0, skipped = 0
      const errors: string[] = []

      try {
        const files = collectFiles(folderPath)
        if (files.length === 0) {
          return { created: 0, skipped: 0, errors: ['No .txt or .md files found in the selected folder'] }
        }
        const total = files.length

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          if (importAbortController.signal.aborted) break
          const batch = files.slice(i, i + BATCH_SIZE)

          for (const file of batch) {
            try {
              const pf = processFile(file, folderPath, format)
              if (pf.skip) {
                if (pf.error) errors.push(pf.error)
                skipped++; continue
              }

              const existing = db.prepare(
                'SELECT id FROM notes WHERE title = ? AND SUBSTR(content,1,200) = ? LIMIT 1'
              ).get(pf.title, pf.fingerprint)
              if (existing) { skipped++; continue }

              const note = notesRepo.createNote({ title: pf.title, content: pf.content }, userId)
              if (note) {
                logAudit(userId, 'note', note.id, 'create', { importSource: format })
                createdNoteIds.push(note.id)
                created++
              } else { skipped++ }
            } catch (err) {
              errors.push(`${path.basename(file)}: ${String(err)}`)
            }
          }

          // Stream progress to renderer (guard against destroyed window)
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.NOTES_IMPORT_PROGRESS, { created, skipped, total })
          }
          // Yield event loop
          await new Promise(resolve => setImmediate(resolve))
        }
      } finally {
        importInFlight = false
      }

      // Fire-and-forget auto-tag pass
      setImmediate(async () => {
        for (const noteId of createdNoteIds) {
          try {
            const note = notesRepo.getNote(noteId)
            if (!note || note.companyId || note.contactId) continue
            const suggestion = await suggestNoteTag(note.content)
            if (suggestion?.companyId) {
              notesRepo.updateNote(noteId, { companyId: suggestion.companyId }, userId)
            } else if (suggestion?.contactId) {
              notesRepo.updateNote(noteId, { contactId: suggestion.contactId }, userId)
            }
          } catch { /* non-fatal */ }
        }
      })

      return { created, skipped, errors }
    }
  )

  // ---------------------------------------------------------------------------
  // NOTES_IMPORT_CANCEL — abort a running import
  // ---------------------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.NOTES_IMPORT_CANCEL, () => {
    importAbortController?.abort()
    return true
  })
}
