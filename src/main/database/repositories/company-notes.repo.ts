import { getDatabase } from '../connection'
import { makeEntityNotesRepo } from './notes-base'
import type { Note } from '../../../shared/types/note'

export type { Note as CompanyNote }

const _repo = makeEntityNotesRepo('company_id')

export const listCompanyNotes = (companyId: string): Note[] =>
  _repo.list(companyId)

export const getCompanyNote = (noteId: string): Note | null =>
  _repo.get(noteId)

/**
 * Creates a company note.
 * If `sourceMeetingId` is provided, checks for an existing note with the same
 * source_meeting_id + company_id pair to avoid duplicates from meeting summary backfill.
 */
export function createCompanyNote(
  data: {
    companyId: string
    themeId?: string | null
    title?: string | null
    content: string
    sourceMeetingId?: string | null
  },
  userId: string | null = null
): Note | null {
  if (data.sourceMeetingId) {
    const db = getDatabase()
    // Check for ANY note linked to this meeting (not just ones already tagged to this company).
    // If the companion note has no company yet → claim it by setting company_id.
    // If it already has the same company → no-op.
    // If it has a DIFFERENT company → fall through and create a new note (multi-company meeting).
    const existing = db
      .prepare(`SELECT id, company_id FROM notes WHERE source_meeting_id = ? LIMIT 1`)
      .get(data.sourceMeetingId) as { id: string; company_id: string | null } | undefined
    if (existing) {
      if (existing.company_id === data.companyId) return _repo.get(existing.id)
      if (existing.company_id === null) {
        db.prepare(`UPDATE notes SET company_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(data.companyId, existing.id)
        return _repo.get(existing.id)
      }
      // existing.company_id is a different company — fall through to create a separate note
    }
  }
  return _repo.create(
    {
      entityId: data.companyId,
      themeId: data.themeId,
      title: data.title,
      content: data.content,
      sourceMeetingId: data.sourceMeetingId,
    },
    userId
  )
}

export const updateCompanyNote = (
  noteId: string,
  data: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>,
  userId: string | null = null
): Note | null => _repo.update(noteId, data, userId)

export const deleteCompanyNote = (noteId: string): boolean =>
  _repo.delete(noteId)

/** The raw repo object, for use with registerEntityNotesIpc. */
export const companyNotesRepo = _repo
