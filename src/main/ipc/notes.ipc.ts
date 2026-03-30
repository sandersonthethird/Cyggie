import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as notesRepo from '../database/repositories/notes.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import { getDatabase } from '../database/connection'
import { getStoragePath } from '../storage/paths'
import { suggestNoteTag, suggestFolderEntityTag, suggestTitleEntityTag } from '../services/note-tagging.service'
import { hydrateCompanionNote } from './note-hydration'
import { convertHtmlToMarkdown } from '../utils/html-to-markdown'
import type { ExtractedImage } from '../utils/html-to-markdown'
import type { NoteCreateData, NoteFilterView, NoteUpdateData } from '../../shared/types/note'
import type { ImportFormat } from '../../shared/types/note'
import { parseFrontmatter, parseAppleNotesDate } from '../utils/frontmatter'

// ---------------------------------------------------------------------------
// Import helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 // 2MB

/** Recursively collect all .txt/.md/.html files under a folder */
export function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) files.push(...collectFiles(full))
    else if (/\.(txt|md|html)$/i.test(e.name)) files.push(full)
  }
  return files
}

/** Build display title from file path: always just the filename stem, no folder prefix. */
export function buildTitleFromPath(filePath: string, _rootFolder: string, format: ImportFormat): string {
  const filename = path.basename(filePath, path.extname(filePath))
  return format === 'notion' ? stripNotionUUID(filename) : filename
}

/**
 * Build the folder_path to store in DB from a file path relative to the root.
 * Root-level files return '' (stored as NULL). Nested files return slash-joined
 * parent segments, always using '/' regardless of OS path separator.
 *
 * Examples:
 *   rootFolder/kick-off.md             → ''
 *   rootFolder/Work/kick-off.md        → 'Work'
 *   rootFolder/Work/Q1/kick-off.md     → 'Work/Q1'
 */
export function buildFolderPath(filePath: string, rootFolder: string): string {
  const parts = path.relative(rootFolder, filePath).split(path.sep)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
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
  content: string        // markdown (converted for .html; as-is for .md/.txt)
  images: ExtractedImage[] // populated only for .html files; empty array otherwise
  fingerprint: string
  skip: boolean
  error?: string
  folderPath: string     // '' for root-level files
  fileDate: string | null     // created_at: from frontmatter or stat.mtime
  fileModified: string | null // updated_at: from frontmatter modified field; null if not present
}

/** Shared per-file logic used by both scan and import handlers.
 *  Returns skip=true for empty, too-large, or unreadable files.
 */
export function processFile(file: string, rootFolder: string, format: ImportFormat): ProcessFileResult {
  const stat = fs.statSync(file)
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return {
      title: '', content: '', images: [], fingerprint: '', skip: true, folderPath: '', fileDate: null, fileModified: null,
      error: `${path.basename(file)}: file too large (>${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)`
    }
  }

  let title = buildTitleFromPath(file, rootFolder, format)
  const folderPath = buildFolderPath(file, rootFolder)
  let fileDate: string | null = stat.mtime.toISOString()
  let fileModified: string | null = null
  const ext = path.extname(file).toLowerCase()

  if (ext === '.html') {
    const html = fs.readFileSync(file, 'utf8')
    const { markdown, images } = convertHtmlToMarkdown(html)
    const trimmed = markdown.trim()
    if (!trimmed) return { title: '', content: '', images: [], fingerprint: '', skip: true, folderPath, fileDate, fileModified }
    return { title, content: trimmed, images, fingerprint: buildFingerprint(trimmed), skip: false, folderPath, fileDate, fileModified }
  }

  let content = fs.readFileSync(file, 'utf8').trim()
  if (!content) return { title: '', content: '', images: [], fingerprint: '', skip: true, folderPath, fileDate, fileModified }

  // Strip frontmatter and extract metadata (e.g. Apple Notes export format)
  if (content.startsWith('---\n')) {
    const parsed = parseFrontmatter(content)
    if (parsed) {
      content = parsed.body
      if (parsed.frontmatter.created) fileDate = parseAppleNotesDate(parsed.frontmatter.created) ?? fileDate
      if (parsed.frontmatter.modified) fileModified = parseAppleNotesDate(parsed.frontmatter.modified)
      if (parsed.frontmatter.title && !title) title = parsed.frontmatter.title
    }
  }

  if (!content) return { title: '', content: '', images: [], fingerprint: '', skip: true, folderPath, fileDate, fileModified }
  return { title, content, images: [], fingerprint: buildFingerprint(content), skip: false, folderPath, fileDate, fileModified }
}

// ---------------------------------------------------------------------------
// Image extraction helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Write extracted images to disk and resolve __IMG_{n}__ placeholders to asset:// URIs.
 *
 * On per-image write failure: placeholder replaced with [image].
 * On total failure: all remaining __IMG_\d+__ tokens stripped to [image].
 *
 *   images[]  ──► write to {assetsDir}/image-NNN.ext
 *                 ──► replace __IMG_{n}__ with asset://note-assets/{noteId}/image-NNN.ext
 */
export function extractImages(
  images: ExtractedImage[],
  assetsDir: string,
  markdownWithPlaceholders: string
): { markdown: string; count: number } {
  try {
    let markdown = markdownWithPlaceholders
    let count = 0

    for (let n = 0; n < images.length; n++) {
      const img = images[n]
      const ext = img.mimeType.replace('jpeg', 'jpg')
      const filename = `image-${String(n).padStart(3, '0')}.${ext}`
      const placeholder = `__IMG_${n}__`

      try {
        fs.mkdirSync(assetsDir, { recursive: true })
        fs.writeFileSync(path.join(assetsDir, filename), Buffer.from(img.data, 'base64'))
        const noteId = path.basename(assetsDir)
        const uri = `asset://note-assets/${noteId}/${filename}`
        markdown = markdown.replace(placeholder, `![image](${uri})`)
        count++
      } catch {
        markdown = markdown.replace(placeholder, '[image]')
      }
    }

    return { markdown, count }
  } catch {
    // Strip any remaining placeholder tokens
    const cleaned = markdownWithPlaceholders.replace(/__IMG_\d+__/g, '[image]')
    return { markdown: cleaned, count: 0 }
  }
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
  ipcMain.handle(
    IPC_CHANNELS.NOTES_LIST,
    (_event, opts: {
      filter?: NoteFilterView
      query?: string
      folderPath?: string | null
      hideClaimedMeetingNotes?: boolean
    } = {}) => {
      const { filter, query, folderPath, hideClaimedMeetingNotes } = opts
      if (query?.trim()) return notesRepo.searchNotes(query.trim(), folderPath, hideClaimedMeetingNotes)
      return notesRepo.listNotes(filter, folderPath, hideClaimedMeetingNotes)
    }
  )

  ipcMain.handle(IPC_CHANNELS.NOTES_GET, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const note = notesRepo.getNote(noteId)
    if (!note) return null
    return hydrateCompanionNote(note)
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_CREATE, (_event, data: NoteCreateData) => {
    if (!data) throw new Error('data is required')
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
        // Broadcast to all windows so timestamps stay current across pop-outs
        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send(IPC_CHANNELS.NOTE_UPDATED, note)
        })
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
      // Clean up extracted images for this note
      const assetsDir = path.join(getStoragePath(), 'note-assets', noteId)
      try { fs.rmSync(assetsDir, { recursive: true, force: true }) } catch { /* non-fatal */ }
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

  ipcMain.handle(IPC_CHANNELS.NOTES_LIST_FOLDERS, () => {
    return notesRepo.listFolders()
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_LIST_IMPORT_SOURCES, () => {
    return notesRepo.listImportSources()
  })

  ipcMain.handle(
    IPC_CHANNELS.NOTES_FOLDER_COUNTS,
    (_event, opts: { hideClaimedMeetingNotes?: boolean } = {}) => {
      return notesRepo.getFolderCounts(opts.hideClaimedMeetingNotes)
    }
  )

  ipcMain.handle(IPC_CHANNELS.NOTES_FOLDER_CREATE, (_event, folderPath: string) => {
    const sanitized = String(folderPath ?? '').trim().replace(/[*?[\]]/g, '')
    if (!sanitized) throw new Error('folderPath is required')
    notesRepo.createFolder(sanitized)
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_FOLDER_RENAME, (_event, oldPath: string, newPath: string) => {
    const sanitizedOld = String(oldPath ?? '').trim()
    const sanitizedNew = String(newPath ?? '').trim().replace(/[*?[\]]/g, '')
    if (!sanitizedOld) throw new Error('oldPath is required')
    if (!sanitizedNew) throw new Error('newPath is required')
    notesRepo.renameFolder(sanitizedOld, sanitizedNew)
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_FOLDER_DELETE, (_event, folderPath: string) => {
    const sanitized = String(folderPath ?? '').trim()
    if (!sanitized) throw new Error('folderPath is required')
    notesRepo.deleteFolder(sanitized)
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
      const assetsBaseDir = path.join(getStoragePath(), 'note-assets')
      let created = 0, skipped = 0, imagesExtracted = 0
      const errors: string[] = []
      const foldersSeenDuringImport = new Set<string>()

      try {
        const files = collectFiles(folderPath)
        if (files.length === 0) {
          return { created: 0, skipped: 0, errors: ['No importable files found in the selected folder'], imagesExtracted: 0, foldersFound: 0 }
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

              // Pre-generate UUID: used for both asset dir and note ID (single write)
              const preGenId = randomUUID()
              let finalContent = pf.content

              if (pf.images.length > 0) {
                const { markdown, count } = extractImages(
                  pf.images,
                  path.join(assetsBaseDir, preGenId),
                  pf.content
                )
                finalContent = markdown
                imagesExtracted += count
              }

              const note = notesRepo.createNote(
                {
                  id: preGenId,
                  title: pf.title,
                  content: finalContent,
                  folderPath: pf.folderPath || null,
                  importSource: format,
                },
                userId,
                pf.fileDate,
                pf.fileModified
              )

              if (note) {
                logAudit(userId, 'note', note.id, 'create', { importSource: format })
                createdNoteIds.push(note.id)
                if (pf.folderPath) foldersSeenDuringImport.add(pf.folderPath)
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

      // Fire-and-forget auto-tag pass (per-note LLM + per-folder fuzzy)
      setImmediate(async () => {
        for (const noteId of createdNoteIds) {
          try {
            const note = notesRepo.getNote(noteId)
            if (!note || note.companyId || note.contactId) continue
            // Title match first (fast, no LLM), then LLM as fallback
          const suggestion = suggestTitleEntityTag(note.title) ?? await suggestNoteTag(note.content)
            if (suggestion?.companyId) {
              notesRepo.tagNote(noteId, { companyId: suggestion.companyId })
            } else if (suggestion?.contactId) {
              notesRepo.tagNote(noteId, { contactId: suggestion.contactId })
            }
          } catch { /* non-fatal */ }
        }

        // Per-folder fuzzy entity match
        const distinctFolders = [...new Set(
          createdNoteIds
            .map(id => notesRepo.getNote(id)?.folderPath)
            .filter((fp): fp is string => Boolean(fp))
        )]
        for (const fp of distinctFolders) {
          try {
            const leafName = fp.split('/').pop()!
            const suggestion = suggestFolderEntityTag(leafName)
            if (suggestion && !event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.NOTES_FOLDER_TAG_SUGGESTION, { folderPath: fp, suggestion })
            }
          } catch { /* non-fatal */ }
        }
      })

      return { created, skipped, errors, imagesExtracted, foldersFound: foldersSeenDuringImport.size }
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
