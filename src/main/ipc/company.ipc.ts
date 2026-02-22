import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import type { CompanyEntityType, CompanyListFilter } from '../../shared/types/company'
import { ingestCompanyEmails } from '../services/company-email-ingest.service'
import { hasDriveFilesScope } from '../calendar/google-auth'
import { listCompanyFilesByDriveFolder } from '../drive/google-drive'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

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
      const userId = getCurrentUserId()
      const created = companyRepo.createCompany(data, userId)
      logAudit(userId, 'company', created.id, 'create', data)
      return created
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
      const userId = getCurrentUserId()
      const updated = companyRepo.updateCompany(companyId, updates || {}, userId)
      if (updated) {
        logAudit(userId, 'company', companyId, 'update', updates || {})
      }
      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_MERGE,
    (_event, targetCompanyId: string, sourceCompanyId: string) => {
      if (!targetCompanyId?.trim() || !sourceCompanyId?.trim()) {
        throw new Error('Both targetCompanyId and sourceCompanyId are required')
      }
      const userId = getCurrentUserId()
      const result = companyRepo.mergeCompanies(targetCompanyId, sourceCompanyId)
      logAudit(userId, 'company', targetCompanyId, 'update', {
        mergedFrom: sourceCompanyId,
        relinked: result.relinked
      })
      logAudit(userId, 'company', sourceCompanyId, 'delete', {
        mergedInto: targetCompanyId
      })
      return result
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
      const userId = getCurrentUserId()

      const company = companyRepo.upsertCompanyClassification({
        canonicalName: data.canonicalName,
        primaryDomain: data.primaryDomain ?? null,
        entityType: data.entityType,
        includeInCompaniesView: data.entityType === 'prospect',
        classificationSource: 'manual',
        classificationConfidence: 1
      }, userId)

      companyRepo.linkMeetingCompany(meetingId, company.id, 1, 'manual', userId)

      const meeting = meetingRepo.getMeeting(meetingId)
      if (meeting) {
        const existingCompanies = meeting.companies || []
        if (!existingCompanies.some((name) => name.toLowerCase() === company.canonicalName.toLowerCase())) {
          meetingRepo.updateMeeting(meetingId, {
            companies: [...existingCompanies, company.canonicalName]
          }, userId)
        }
      }

      logAudit(userId, 'meeting_company_link', `${meetingId}:${company.id}`, 'create', {
        meetingId,
        companyId: company.id
      })

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
