import { makeEntityNotesRepo } from './notes-base'
import type { Note } from '../../../shared/types/note'

export type { Note as ContactNote }

const _repo = makeEntityNotesRepo('contact_id')

export const listContactNotes = (contactId: string): Note[] =>
  _repo.list(contactId)

export const getContactNote = (noteId: string): Note | null =>
  _repo.get(noteId)

export function createContactNote(
  data: {
    contactId: string
    themeId?: string | null
    title?: string | null
    content: string
    sourceMeetingId?: string | null
  },
  userId: string | null = null
): Note | null {
  return _repo.create(
    {
      entityId: data.contactId,
      themeId: data.themeId,
      title: data.title,
      content: data.content,
      sourceMeetingId: data.sourceMeetingId,
    },
    userId
  )
}

export const updateContactNote = (
  noteId: string,
  data: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>,
  userId: string | null = null
): Note | null => _repo.update(noteId, data, userId)

export const deleteContactNote = (noteId: string): boolean =>
  _repo.delete(noteId)

/** The raw repo object, for use with registerEntityNotesIpc. */
export const contactNotesRepo = _repo
