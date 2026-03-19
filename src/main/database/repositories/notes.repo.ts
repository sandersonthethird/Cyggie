import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { Note, NoteFilterView, NoteCreateData, NoteUpdateData } from '../../../shared/types/note'

interface NoteRow {
  id: string
  title: string | null
  content: string
  company_id: string | null
  contact_id: string | null
  source_meeting_id: string | null
  theme_id: string | null
  is_pinned: number
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
  company_name?: string | null
  contact_name?: string | null
}

function rowToNote(row: NoteRow): Note {
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
    companyName: row.company_name ?? null,
    contactName: row.contact_name ?? null,
  }
}

const BASE_SELECT = `
  SELECT
    n.id,
    n.title,
    n.content,
    n.company_id,
    n.contact_id,
    n.source_meeting_id,
    n.theme_id,
    n.is_pinned,
    n.created_by_user_id,
    n.updated_by_user_id,
    n.created_at,
    n.updated_at,
    c.canonical_name AS company_name,
    ct.full_name AS contact_name
  FROM notes n
  LEFT JOIN org_companies c ON c.id = n.company_id
  LEFT JOIN contacts ct ON ct.id = n.contact_id
`

export function listNotes(filter: NoteFilterView = 'all'): Note[] {
  const db = getDatabase()
  let whereClause = ''
  if (filter === 'untagged') {
    whereClause = 'WHERE n.company_id IS NULL AND n.contact_id IS NULL'
  } else if (filter === 'tagged') {
    whereClause = 'WHERE (n.company_id IS NOT NULL OR n.contact_id IS NOT NULL)'
  }
  const rows = db
    .prepare(`${BASE_SELECT} ${whereClause} ORDER BY n.is_pinned DESC, datetime(n.updated_at) DESC`)
    .all() as NoteRow[]
  return rows.map(rowToNote)
}

export function searchNotes(query: string): Note[] {
  const db = getDatabase()
  const sanitized = query.replace(/["()*^]/g, '').trim()
  if (!sanitized) return listNotes()
  try {
    const rows = db
      .prepare(`${BASE_SELECT} JOIN notes_fts nf ON nf.id = n.id WHERE notes_fts MATCH ? ORDER BY rank`)
      .all(sanitized + '*') as NoteRow[]
    return rows.map(rowToNote)
  } catch {
    return listNotes()
  }
}

export function getNote(noteId: string): Note | null {
  const db = getDatabase()
  const row = db
    .prepare(`${BASE_SELECT} WHERE n.id = ?`)
    .get(noteId) as NoteRow | undefined
  return row ? rowToNote(row) : null
}

export function createNote(data: NoteCreateData, userId: string | null = null): Note | null {
  const db = getDatabase()
  const id = randomUUID()
  const result = db.prepare(`
    INSERT INTO notes (
      id, title, content, company_id, contact_id, source_meeting_id, theme_id,
      is_pinned, created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.title ?? null,
    data.content,
    data.companyId ?? null,
    data.contactId ?? null,
    data.sourceMeetingId ?? null,
    data.themeId ?? null,
    userId,
    userId
  )
  if (result.changes === 0) return null
  return getNote(id)
}

export function updateNote(
  noteId: string,
  data: NoteUpdateData,
  userId: string | null = null
): Note | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.title !== undefined) {
    sets.push('title = ?')
    params.push(data.title)
  }
  if (data.content !== undefined) {
    sets.push('content = ?')
    params.push(data.content)
  }
  if (data.isPinned !== undefined) {
    sets.push('is_pinned = ?')
    params.push(data.isPinned ? 1 : 0)
  }
  if (data.themeId !== undefined) {
    sets.push('theme_id = ?')
    params.push(data.themeId)
  }
  if (data.companyId !== undefined) {
    sets.push('company_id = ?')
    params.push(data.companyId)
  }
  if (data.contactId !== undefined) {
    sets.push('contact_id = ?')
    params.push(data.contactId)
  }

  if (sets.length === 0) return getNote(noteId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(noteId)
  db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getNote(noteId)
}

export function deleteNote(noteId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
  return result.changes > 0
}
