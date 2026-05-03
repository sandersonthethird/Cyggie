import { IPC_CHANNELS } from '../../shared/constants/channels'
import { makeEntityNotesRepo } from '../database/repositories/notes-base'
import { ensureCompanyMeetingSummaryNotes } from '../services/note-companion-backfill.service'
import { registerEntityNotesIpc } from './notes-ipc-base'

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
    repo: makeEntityNotesRepo('company_id'),
    onBeforeList: ensureCompanyMeetingSummaryNotes,
  })
}
