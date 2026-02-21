import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as contactRepo from '../database/repositories/contact.repo'

export function registerContactHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONTACT_LIST,
    (_event, filter?: { query?: string; limit?: number; offset?: number }) => {
      return contactRepo.listContacts(filter)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_CREATE,
    (_event, data: { fullName: string; email: string; title?: string | null }) => {
      if (!data?.fullName?.trim()) throw new Error('fullName is required')
      if (!data?.email?.trim()) throw new Error('email is required')
      return contactRepo.createContact(data)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS, () => {
    return contactRepo.syncContactsFromMeetings()
  })

  try {
    contactRepo.syncContactsFromMeetings()
  } catch (err) {
    console.error('[Contacts] Startup sync failed:', err)
  }
}
