import { IPC_CHANNELS } from '../../shared/constants/channels'
import { companyNotesRepo, createCompanyNote } from '../database/repositories/company-notes.repo'
import { listCompanyMeetingSummaryPaths } from '../database/repositories/org-company.repo'
import { readSummary } from '../storage/file-manager'
import { registerEntityNotesIpc } from './notes-ipc-base'

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
      createCompanyNote(
        { companyId, title: noteTitle, content: noteContent, sourceMeetingId: row.meetingId },
        userId
      )
    }
  } catch (err) {
    console.error('[Company Notes] Failed to backfill meeting summaries:', err)
  }
}

export function registerCompanyNotesHandlers(): void {
  registerEntityNotesIpc({
    channels: {
      list: IPC_CHANNELS.COMPANY_NOTES_LIST,
      get: IPC_CHANNELS.COMPANY_NOTES_GET,
      create: IPC_CHANNELS.COMPANY_NOTES_CREATE,
      update: IPC_CHANNELS.COMPANY_NOTES_UPDATE,
      delete: IPC_CHANNELS.COMPANY_NOTES_DELETE,
    },
    entityIdParam: 'companyId',
    auditType: 'company_note',
    repo: companyNotesRepo,
    onBeforeList: ensureCompanyMeetingSummaryNotes,
  })
}
