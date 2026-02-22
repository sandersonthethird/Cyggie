import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as notesRepo from '../database/repositories/company-notes.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

export function registerCompanyNotesHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPANY_NOTES_LIST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return notesRepo.listCompanyNotes(companyId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_NOTES_CREATE,
    (_event, data: { companyId: string; title?: string | null; content: string; themeId?: string | null }) => {
      if (!data?.companyId) throw new Error('companyId is required')
      if (!data.content?.trim()) throw new Error('content is required')
      const userId = getCurrentUserId()
      const note = notesRepo.createCompanyNote({
        companyId: data.companyId,
        title: data.title ?? null,
        content: data.content,
        themeId: data.themeId ?? null
      }, userId)
      logAudit(userId, 'company_note', note.id, 'create', data)
      return note
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_NOTES_UPDATE,
    (
      _event,
      noteId: string,
      updates: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>
    ) => {
      if (!noteId) throw new Error('noteId is required')
      const userId = getCurrentUserId()
      const note = notesRepo.updateCompanyNote(noteId, updates || {}, userId)
      if (note) {
        logAudit(userId, 'company_note', noteId, 'update', updates || {})
      }
      return note
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_NOTES_DELETE, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const userId = getCurrentUserId()
    const deleted = notesRepo.deleteCompanyNote(noteId)
    if (deleted) {
      logAudit(userId, 'company_note', noteId, 'delete', null)
    }
    return deleted
  })
}
