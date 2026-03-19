import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as notesRepo from '../database/repositories/contact-notes.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import { hydrateCompanionNote } from './note-hydration'

export function registerContactNotesHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONTACT_NOTES_LIST, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return notesRepo.listContactNotes(contactId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_NOTES_GET, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const note = notesRepo.getContactNote(noteId)
    if (!note) return null
    return hydrateCompanionNote(note, getCurrentUserId())
  })

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_NOTES_CREATE,
    (_event, data: { contactId: string; title?: string | null; content: string; themeId?: string | null }) => {
      if (!data?.contactId) throw new Error('contactId is required')
      if (!data.content?.trim()) throw new Error('content is required')
      const userId = getCurrentUserId()
      const note = notesRepo.createContactNote({
        contactId: data.contactId,
        title: data.title ?? null,
        content: data.content,
        themeId: data.themeId ?? null
      }, userId)
      if (!note) throw new Error('Failed to create note')
      logAudit(userId, 'contact_note', note.id, 'create', data)
      return note
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_NOTES_UPDATE,
    (
      _event,
      noteId: string,
      updates: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>
    ) => {
      if (!noteId) throw new Error('noteId is required')
      const userId = getCurrentUserId()
      const note = notesRepo.updateContactNote(noteId, updates || {}, userId)
      if (note) {
        logAudit(userId, 'contact_note', noteId, 'update', updates || {})
      }
      return note
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_NOTES_DELETE, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const userId = getCurrentUserId()
    const deleted = notesRepo.deleteContactNote(noteId)
    if (deleted) {
      logAudit(userId, 'contact_note', noteId, 'delete', null)
    }
    return deleted
  })
}
