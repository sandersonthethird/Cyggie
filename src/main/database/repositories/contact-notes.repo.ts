import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { ContactNote } from '../../../shared/types/contact'

interface ContactNoteRow {
  id: string
  contact_id: string
  theme_id: string | null
  title: string | null
  content: string
  is_pinned: number
  created_at: string
  updated_at: string
}

function rowToContactNote(row: ContactNoteRow): ContactNote {
  return {
    id: row.id,
    contactId: row.contact_id,
    themeId: row.theme_id,
    title: row.title,
    content: row.content,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listContactNotes(contactId: string): ContactNote[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, contact_id, theme_id, title, content, is_pinned, created_at, updated_at
      FROM contact_notes
      WHERE contact_id = ?
      ORDER BY is_pinned DESC, datetime(updated_at) DESC
    `)
    .all(contactId) as ContactNoteRow[]
  return rows.map(rowToContactNote)
}

export function createContactNote(data: {
  contactId: string
  themeId?: string | null
  title?: string | null
  content: string
}, userId: string | null = null): ContactNote {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO contact_notes (
      id, contact_id, theme_id, title, content, is_pinned,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
  `).run(id, data.contactId, data.themeId ?? null, data.title ?? null, data.content, userId, userId)
  return getContactNote(id)!
}

export function getContactNote(noteId: string): ContactNote | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, contact_id, theme_id, title, content, is_pinned, created_at, updated_at
      FROM contact_notes WHERE id = ?
    `)
    .get(noteId) as ContactNoteRow | undefined
  return row ? rowToContactNote(row) : null
}

export function updateContactNote(
  noteId: string,
  data: Partial<{
    title: string | null
    content: string
    isPinned: boolean
    themeId: string | null
  }>,
  userId: string | null = null
): ContactNote | null {
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

  if (sets.length === 0) return getContactNote(noteId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(noteId)
  db.prepare(`UPDATE contact_notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getContactNote(noteId)
}

export function deleteContactNote(noteId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM contact_notes WHERE id = ?').run(noteId)
  return result.changes > 0
}
