import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as notesRepo from '../database/repositories/company-notes.repo'
import { listCompanyMeetingSummaryPaths } from '../database/repositories/org-company.repo'
import { getCurrentUserId } from '../security/current-user'
import { readSummary } from '../storage/file-manager'
import { logAudit } from '../database/repositories/audit.repo'

function ensureCompanyMeetingSummaryNotes(companyId: string, userId: string | null): void {
  try {
    const rows = listCompanyMeetingSummaryPaths(companyId)
    for (const row of rows) {
      let summary: string | null = null
      try {
        summary = readSummary(row.summaryPath)
      } catch (err) {
        console.warn('[Company Notes] Failed to read summary:', err)
        continue
      }
      if (!summary) continue
      const noteTitle = row.title?.trim() || 'Meeting'
      const noteContent = `${noteTitle}\n${summary}`
      notesRepo.createCompanyNote(
        { companyId, title: noteTitle, content: noteContent, sourceMeetingId: row.meetingId },
        userId
      )
    }
  } catch (err) {
    console.error('[Company Notes] Failed to backfill meeting summaries:', err)
  }
}

export function registerCompanyNotesHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPANY_NOTES_LIST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    const userId = getCurrentUserId()
    ensureCompanyMeetingSummaryNotes(companyId, userId)
    return notesRepo.listCompanyNotes(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_NOTES_GET, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    return notesRepo.getCompanyNote(noteId)
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
      if (!note) throw new Error('Failed to create note')
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
