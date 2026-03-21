/**
 * Shared CRUD factory for entity-scoped note operations.
 *
 * Both contact notes and company notes live in the same `notes` table,
 * differing only in which FK column is populated (contact_id vs company_id).
 * This factory eliminates the duplicated list/get/create/update/delete logic.
 *
 * Usage:
 *   const repo = makeEntityNotesRepo('contact_id')
 *   const repo = makeEntityNotesRepo('company_id')
 *
 * The returned repo uses `entityId` as the generic identifier in `create`.
 * Callers that need the original named signatures (createContactNote, etc.)
 * should wrap the factory result — see contact-notes.repo.ts and company-notes.repo.ts.
 */

import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { Note } from '../../../shared/types/note'

export type EntityFkCol = 'contact_id' | 'company_id'

interface NoteBaseRow {
  id: string
  contact_id: string | null
  company_id: string | null
  theme_id: string | null
  title: string | null
  content: string
  is_pinned: number
  source_meeting_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
  folder_path: string | null
  import_source: string | null
}

const SELECT_COLS = `
  id, contact_id, company_id, theme_id, title, content,
  is_pinned, source_meeting_id, created_by_user_id, updated_by_user_id,
  created_at, updated_at, folder_path, import_source
`

function rowToNote(row: NoteBaseRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    companyId: row.company_id,
    contactId: row.contact_id,
    sourceMeetingId: row.source_meeting_id,
    themeId: row.theme_id,
    isPinned: row.is_pinned === 1,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    folderPath: row.folder_path ?? null,
    importSource: row.import_source ?? null,
  }
}

export interface EntityNotesRepo {
  list(entityId: string): Note[]
  get(noteId: string): Note | null
  create(
    data: {
      entityId: string
      themeId?: string | null
      title?: string | null
      content: string
      sourceMeetingId?: string | null
    },
    userId?: string | null
  ): Note | null
  update(
    noteId: string,
    data: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>,
    userId?: string | null
  ): Note | null
  delete(noteId: string): boolean
}

export function makeEntityNotesRepo(entityFkCol: EntityFkCol): EntityNotesRepo {
  function get(noteId: string): Note | null {
    const db = getDatabase()
    const row = db
      .prepare(`SELECT ${SELECT_COLS} FROM notes WHERE id = ?`)
      .get(noteId) as NoteBaseRow | undefined
    return row ? rowToNote(row) : null
  }

  function list(entityId: string): Note[] {
    const db = getDatabase()
    const rows = db
      .prepare(`
        SELECT ${SELECT_COLS}
        FROM notes
        WHERE ${entityFkCol} = ?
        ORDER BY is_pinned DESC, datetime(updated_at) DESC
      `)
      .all(entityId) as NoteBaseRow[]
    return rows.map(rowToNote)
  }

  function create(
    data: {
      entityId: string
      themeId?: string | null
      title?: string | null
      content: string
      sourceMeetingId?: string | null
    },
    userId: string | null = null
  ): Note | null {
    const db = getDatabase()
    const id = randomUUID()
    const result = db
      .prepare(`
        INSERT INTO notes (
          id, ${entityFkCol}, theme_id, title, content, is_pinned, source_meeting_id,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'), datetime('now'))
      `)
      .run(
        id,
        data.entityId,
        data.themeId ?? null,
        data.title ?? null,
        data.content,
        data.sourceMeetingId ?? null,
        userId,
        userId
      )
    if (result.changes === 0) return null
    return get(id)!
  }

  function update(
    noteId: string,
    data: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>,
    userId: string | null = null
  ): Note | null {
    const db = getDatabase()
    const sets: string[] = []
    const params: unknown[] = []

    if (data.title !== undefined) { sets.push('title = ?'); params.push(data.title) }
    if (data.content !== undefined) { sets.push('content = ?'); params.push(data.content) }
    if (data.isPinned !== undefined) { sets.push('is_pinned = ?'); params.push(data.isPinned ? 1 : 0) }
    if (data.themeId !== undefined) { sets.push('theme_id = ?'); params.push(data.themeId) }

    if (sets.length === 0) return get(noteId)

    if (userId) { sets.push('updated_by_user_id = ?'); params.push(userId) }
    sets.push("updated_at = datetime('now')")
    params.push(noteId)
    db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return get(noteId)
  }

  function deleteFn(noteId: string): boolean {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
    return result.changes > 0
  }

  return { list, get, create, update, delete: deleteFn }
}
