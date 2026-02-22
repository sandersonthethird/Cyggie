import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { CompanyNote } from '../../../shared/types/company'

interface CompanyNoteRow {
  id: string
  company_id: string
  theme_id: string | null
  title: string | null
  content: string
  is_pinned: number
  created_at: string
  updated_at: string
}

function rowToCompanyNote(row: CompanyNoteRow): CompanyNote {
  return {
    id: row.id,
    companyId: row.company_id,
    themeId: row.theme_id,
    title: row.title,
    content: row.content,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listCompanyNotes(companyId: string): CompanyNote[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, company_id, theme_id, title, content, is_pinned, created_at, updated_at
      FROM company_notes
      WHERE company_id = ?
      ORDER BY is_pinned DESC, datetime(updated_at) DESC
    `)
    .all(companyId) as CompanyNoteRow[]
  return rows.map(rowToCompanyNote)
}

export function createCompanyNote(data: {
  companyId: string
  themeId?: string | null
  title?: string | null
  content: string
}, userId: string | null = null): CompanyNote {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO company_notes (
      id, company_id, theme_id, title, content, is_pinned,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
  `).run(id, data.companyId, data.themeId ?? null, data.title ?? null, data.content, userId, userId)
  return getCompanyNote(id)!
}

export function getCompanyNote(noteId: string): CompanyNote | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, company_id, theme_id, title, content, is_pinned, created_at, updated_at
      FROM company_notes WHERE id = ?
    `)
    .get(noteId) as CompanyNoteRow | undefined
  return row ? rowToCompanyNote(row) : null
}

export function updateCompanyNote(
  noteId: string,
  data: Partial<{
    title: string | null
    content: string
    isPinned: boolean
    themeId: string | null
  }>,
  userId: string | null = null
): CompanyNote | null {
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

  if (sets.length === 0) return getCompanyNote(noteId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(noteId)
  db.prepare(`UPDATE company_notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getCompanyNote(noteId)
}

export function deleteCompanyNote(noteId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM company_notes WHERE id = ?').run(noteId)
  return result.changes > 0
}
