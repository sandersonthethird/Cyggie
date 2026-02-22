import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import type { CompanyEntityType, CompanyListFilter } from '../../shared/types/company'
import { ingestCompanyEmails } from '../services/company-email-ingest.service'
import { hasDriveFilesScope } from '../calendar/google-auth'
import { listCompanyFilesByDriveFolder } from '../drive/google-drive'

export function registerCompanyHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_LIST,
    (_event, filter?: CompanyListFilter) => {
      return companyRepo.listCompanies(filter)
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_GET, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.getCompany(companyId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_CREATE,
    (_event, data: {
      canonicalName: string
      description?: string | null
      primaryDomain?: string | null
      websiteUrl?: string | null
      stage?: string | null
      status?: string
      entityType?: CompanyEntityType
    }) => {
      if (!data?.canonicalName?.trim()) {
        throw new Error('Company name is required')
      }
      return companyRepo.createCompany(data)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_UPDATE,
    (_event, companyId: string, updates: Partial<{
      canonicalName: string
      description: string | null
      primaryDomain: string | null
      websiteUrl: string | null
      stage: string | null
      status: string
      entityType: CompanyEntityType
      includeInCompaniesView: boolean
      classificationSource: 'manual' | 'auto'
      classificationConfidence: number | null
    }>) => {
      if (!companyId) throw new Error('companyId is required')
      return companyRepo.updateCompany(companyId, updates || {})
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_TAG_FROM_MEETING,
    (
      _event,
      meetingId: string,
      data: {
        canonicalName: string
        primaryDomain?: string | null
        entityType: CompanyEntityType
      }
    ) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!data?.canonicalName?.trim()) throw new Error('canonicalName is required')

      const company = companyRepo.upsertCompanyClassification({
        canonicalName: data.canonicalName,
        primaryDomain: data.primaryDomain ?? null,
        entityType: data.entityType,
        includeInCompaniesView: data.entityType === 'prospect',
        classificationSource: 'manual',
        classificationConfidence: 1
      })

      companyRepo.linkMeetingCompany(meetingId, company.id, 1, 'manual')

      const meeting = meetingRepo.getMeeting(meetingId)
      if (meeting) {
        const existingCompanies = meeting.companies || []
        if (!existingCompanies.some((name) => name.toLowerCase() === company.canonicalName.toLowerCase())) {
          meetingRepo.updateMeeting(meetingId, {
            companies: [...existingCompanies, company.canonicalName]
          })
        }
      }

      return company
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_MEETINGS, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.listCompanyMeetings(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_CONTACTS, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.listCompanyContacts(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_EMAILS, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.listCompanyEmails(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_EMAIL_INGEST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return ingestCompanyEmails(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_FILES, async (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    if (!hasDriveFilesScope()) return []

    const company = companyRepo.getCompany(companyId)
    if (!company) return []

    const rootFolderRef = (settingsRepo.getSetting('companyDriveRootFolder') || '').trim()
    if (!rootFolderRef) return []

    try {
      return await listCompanyFilesByDriveFolder(
        rootFolderRef,
        company.canonicalName,
        company.primaryDomain
      )
    } catch (err) {
      console.error('[Company Files] Failed to list company Drive files:', err)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_TIMELINE, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.listCompanyTimeline(companyId)
  })
}
