import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as contactRepo from '../database/repositories/contact.repo'
import * as companyRepo from '../database/repositories/org-company.repo'
import { ingestContactEmails } from '../services/company-email-ingest.service'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

export function registerContactHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONTACT_LIST,
    (_event, filter?: { query?: string; limit?: number; offset?: number; includeStats?: boolean }) => {
      if (filter?.includeStats) {
        return contactRepo.listContacts(filter)
      }
      return contactRepo.listContactsLight(filter)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_GET, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return contactRepo.getContact(contactId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_EMAILS, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return contactRepo.listContactEmails(contactId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_EMAIL_INGEST, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return ingestContactEmails(contactId)
  })

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_CREATE,
    (
      _event,
      data: {
        fullName: string
        firstName?: string | null
        lastName?: string | null
        email: string
        title?: string | null
      }
    ) => {
      if (!data?.fullName?.trim()) throw new Error('fullName is required')
      if (!data?.email?.trim()) throw new Error('email is required')
      const userId = getCurrentUserId()
      const created = contactRepo.createContact(data, userId)
      logAudit(userId, 'contact', created.id, 'create', data)
      return created
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_UPDATE,
    (
      _event,
      contactId: string,
      data: {
        fullName?: string
        firstName?: string | null
        lastName?: string | null
        title?: string | null
        contactType?: string | null
        linkedinUrl?: string | null
      }
    ) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      const userId = getCurrentUserId()
      const updated = contactRepo.updateContact(contactId, data, userId)
      logAudit(userId, 'contact', contactId, 'update', data)
      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_SET_COMPANY,
    (_event, contactId: string, companyName: string) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      if (!companyName?.trim()) throw new Error('Company name is required')
      const userId = getCurrentUserId()

      const company = companyRepo.getOrCreateCompanyByName(companyName, userId)
      const updated = contactRepo.setContactPrimaryCompany(contactId, company.id, userId)
      logAudit(userId, 'contact', contactId, 'update', {
        primaryCompanyId: company.id
      })
      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_ADD_EMAIL,
    (_event, contactId: string, email: string) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      if (!email?.trim()) throw new Error('email is required')
      const userId = getCurrentUserId()
      const updated = contactRepo.addContactEmail(contactId, email, userId)
      logAudit(userId, 'contact', contactId, 'update', {
        addedEmail: email
      })
      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_RESOLVE_EMAILS,
    (_event, emails: string[]) => {
      if (!Array.isArray(emails)) return {}
      return contactRepo.resolveContactsByEmails(emails)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS, () => {
    const userId = getCurrentUserId()
    const result = contactRepo.syncContactsFromMeetings(userId)
    logAudit(userId, 'contact', 'sync-from-meetings', 'update', result)
    return result
  })

  try {
    contactRepo.syncContactsFromMeetings(getCurrentUserId())
  } catch (err) {
    console.error('[Contacts] Startup sync failed:', err)
  }
}
