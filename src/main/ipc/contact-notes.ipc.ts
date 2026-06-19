import { IPC_CHANNELS } from '../../shared/constants/channels'
import { makeSyncedEntityNotesRepo } from '@cyggie/db/sqlite/repositories'
import { ensureContactMeetingSummaryNotes } from '../services/note-companion-backfill.service'
import { registerEntityNotesIpc } from './notes-ipc-base'

export function registerContactNotesHandlers(): void {
  registerEntityNotesIpc({
    channels: {
      list: IPC_CHANNELS.CONTACT_NOTES_LIST,
      get: IPC_CHANNELS.CONTACT_NOTES_GET,
      create: IPC_CHANNELS.CONTACT_NOTES_CREATE,
      update: IPC_CHANNELS.CONTACT_NOTES_UPDATE,
      delete: IPC_CHANNELS.CONTACT_NOTES_DELETE,
    },
    entityIdParam: 'contactId',
    auditType: 'contact_note',
    repo: makeSyncedEntityNotesRepo('contact_id'),
    onBeforeList: ensureContactMeetingSummaryNotes,
  })
}
