import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as contactRepo from '../database/repositories/contact.repo'
import * as companyRepo from '../database/repositories/org-company.repo'
import { ingestContactEmails, cancelContactEmailIngest } from '../services/company-email-ingest.service'
import {
  enrichContactsViaWebLookup,
  mergeContactEnrichmentResults
} from '../services/contact-web-enrichment'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import type {
  ContactEnrichmentOptions,
  ContactSortBy,
  ContactDedupDecision,
  ContactEmailOnboardingOptions,
  ContactEmailOnboardingResult,
  ContactEmailOnboardingProgress,
  ContactEmailOnboardingProgressStage
} from '../../shared/types/contact'

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function registerContactHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONTACT_LIST,
    (_event, filter?: {
      query?: string
      limit?: number
      offset?: number
      includeStats?: boolean
      includeActivityTouchpoint?: boolean
      sortBy?: ContactSortBy
    }) => {
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

  ipcMain.handle(IPC_CHANNELS.CONTACT_TIMELINE, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return contactRepo.listContactTimeline(contactId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_EMAIL_INGEST, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return ingestContactEmails(contactId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_EMAIL_INGEST_CANCEL, (_event, contactId: string) => {
    cancelContactEmailIngest(contactId)
    return { cancelled: true }
  })

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_CREATE,
    (
      _event,
      data: {
        fullName: string
        firstName?: string | null
        lastName?: string | null
        email?: string | null
        title?: string | null
        contactType?: string | null
        linkedinUrl?: string | null
        companyName?: string | null
      }
    ) => {
      if (!data?.fullName?.trim()) throw new Error('fullName is required')
      const userId = getCurrentUserId()
      const created = contactRepo.createContact(data, userId)

      // Set company by name if provided
      if (data.companyName?.trim()) {
        try {
          const company = companyRepo.getOrCreateCompanyByName(data.companyName.trim(), userId)
          contactRepo.setContactPrimaryCompany(created.id, company.id, userId)
        } catch { /* ignore company linking errors */ }
      }

      logAudit(userId, 'contact', created.id, 'create', data)
      return created
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_UPDATE,
    (
      _event,
      contactId: string,
      data: Record<string, unknown>
    ) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      const userId = getCurrentUserId()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = contactRepo.updateContact(contactId, data as any, userId)
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

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_DEDUP_SUSPECTED,
    (_event, limit?: number) => {
      return contactRepo.listSuspectedDuplicateContacts(limit)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_DEDUP_APPLY,
    (_event, decisions: ContactDedupDecision[]) => {
      if (!Array.isArray(decisions)) {
        throw new Error('decisions must be an array')
      }
      const userId = getCurrentUserId()
      const result = contactRepo.applyContactDedupDecisions(decisions, userId)
      logAudit(userId, 'contact', 'dedup-bulk', 'update', {
        reviewedGroups: result.reviewedGroups,
        mergedGroups: result.mergedGroups,
        deletedGroups: result.deletedGroups,
        skippedGroups: result.skippedGroups,
        mergedContacts: result.mergedContacts,
        deletedContacts: result.deletedContacts,
        failures: result.failures.slice(0, 20)
      })
      return result
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS, () => {
    const userId = getCurrentUserId()
    const result = contactRepo.syncContactsFromMeetings(userId)
    logAudit(userId, 'contact', 'sync-from-meetings', 'update', result)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_ENRICH_EXISTING, async (_event, options?: ContactEnrichmentOptions) => {
    const userId = getCurrentUserId()
    const baseResult = contactRepo.enrichExistingContacts(userId)
    let result = baseResult

    if (options?.webLookup) {
      const candidates = contactRepo
        .listContactsLight({
          limit: options.webLookupLimit ?? 5000,
          sortBy: 'recent_touch'
        })
        .filter((contact) => !contact.primaryCompanyId || !contact.title || !contact.linkedinUrl)
        .map((contact) => contact.id)
      const webResult = await enrichContactsViaWebLookup(candidates, userId, options)
      result = mergeContactEnrichmentResults(baseResult, webResult)
    }

    logAudit(userId, 'contact', 'enrich-existing', 'update', result)
    return result
  })

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_ENRICH_ONE,
    async (_event, contactId: string, options?: ContactEnrichmentOptions) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      const userId = getCurrentUserId()
      const baseResult = contactRepo.enrichContact(contactId, userId)
      let result = baseResult

      if (options?.webLookup) {
        const webResult = await enrichContactsViaWebLookup([contactId], userId, options)
        result = mergeContactEnrichmentResults(baseResult, webResult)
      }

      logAudit(userId, 'contact', contactId, 'update', {
        action: 'enrich-one',
        ...result
      })
      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_ONBOARD_FROM_EMAIL,
    async (event, options?: ContactEmailOnboardingOptions) => {
      const userId = getCurrentUserId()
      const candidates = contactRepo.listContactsForEmailOnboarding(options?.maxContacts ?? 5000)
      const ingestOnlyMissingEmailHistory = options?.ingestOnlyMissingEmailHistory !== false
      const totalContacts = candidates.length
      const result: ContactEmailOnboardingResult = {
        scannedContacts: 0,
        attemptedIngest: 0,
        skippedAlreadyIngested: 0,
        ingestedContacts: 0,
        ingestFailures: 0,
        enrichedContacts: 0,
        enrichmentFailures: 0,
        insertedMessageCount: 0,
        updatedMessageCount: 0,
        linkedMessageCount: 0,
        linkedContactCount: 0,
        updatedNames: 0,
        updatedLinkedinUrls: 0,
        updatedTitles: 0,
        linkedCompanies: 0,
        webLookups: 0,
        skippedEnrichment: 0,
        failures: []
      }
      let completedContacts = 0

      const emitProgress = (
        stage: ContactEmailOnboardingProgressStage,
        currentContact: { id: string; fullName: string } | null
      ) => {
        const progress: ContactEmailOnboardingProgress = {
          stage,
          totalContacts,
          processedContacts: result.scannedContacts,
          completedContacts,
          currentContactId: currentContact?.id ?? null,
          currentContactName: currentContact?.fullName ?? null,
          attemptedIngest: result.attemptedIngest,
          skippedAlreadyIngested: result.skippedAlreadyIngested,
          ingestedContacts: result.ingestedContacts,
          ingestFailures: result.ingestFailures,
          enrichedContacts: result.enrichedContacts,
          enrichmentFailures: result.enrichmentFailures
        }
        event.sender.send(IPC_CHANNELS.CONTACT_ONBOARD_PROGRESS, progress)
      }

      try {
        emitProgress('starting', null)

        const processCandidate = async (candidate: { id: string; fullName: string }) => {
          result.scannedContacts += 1
          emitProgress('checking', candidate)

          let shouldIngest = true
          if (ingestOnlyMissingEmailHistory) {
            shouldIngest = !contactRepo.hasContactEmailHistory(candidate.id)
            if (!shouldIngest) {
              result.skippedAlreadyIngested += 1
            }
          }

          if (shouldIngest) {
            result.attemptedIngest += 1
            emitProgress('ingesting', candidate)
            try {
              const ingestResult = await ingestContactEmails(candidate.id)
              result.ingestedContacts += 1
              result.insertedMessageCount += ingestResult.insertedMessageCount
              result.updatedMessageCount += ingestResult.updatedMessageCount
              result.linkedMessageCount += ingestResult.linkedMessageCount
              result.linkedContactCount += ingestResult.linkedContactCount
            } catch (err) {
              result.ingestFailures += 1
              result.failures.push({
                contactId: candidate.id,
                contactName: candidate.fullName,
                stage: 'ingest',
                reason: toErrorMessage(err)
              })
            }
          }
          completedContacts += 1
          emitProgress('checking', candidate)
        }

        const maxConcurrency = 2
        const workerCount = Math.max(1, Math.min(maxConcurrency, totalContacts))
        let cursor = 0

        const worker = async () => {
          while (cursor < candidates.length) {
            const index = cursor
            cursor += 1
            const candidate = candidates[index]
            if (!candidate) break
            await processCandidate(candidate)
          }
        }

        await Promise.all(Array.from({ length: workerCount }, () => worker()))

        emitProgress('enriching', null)
        try {
          const candidateIds = candidates.map((candidate) => candidate.id)
          const baseResult = contactRepo.enrichContactsByIds(candidateIds, userId)
          let enrichmentResult = baseResult
          if (options?.webLookup) {
            const webResult = await enrichContactsViaWebLookup(candidateIds, userId, {
              ...options,
              webLookupLimit: options.webLookupLimit ?? Math.min(candidateIds.length, 1000)
            })
            enrichmentResult = mergeContactEnrichmentResults(baseResult, webResult)
          }

          result.enrichedContacts = enrichmentResult.scannedContacts
          result.updatedNames += enrichmentResult.updatedNames
          result.updatedLinkedinUrls += enrichmentResult.updatedLinkedinUrls
          result.updatedTitles += enrichmentResult.updatedTitles
          result.linkedCompanies += enrichmentResult.linkedCompanies
          result.webLookups += enrichmentResult.webLookups
          result.skippedEnrichment += enrichmentResult.skipped
        } catch (err) {
          result.enrichmentFailures += 1
          result.failures.push({
            contactId: '',
            contactName: 'Batch enrichment',
            stage: 'enrich',
            reason: toErrorMessage(err)
          })
        }

        emitProgress('completed', null)
        logAudit(userId, 'contact', 'onboard-from-email', 'update', {
          ...result,
          failures: result.failures.slice(0, 20)
        })
        return result
      } catch (err) {
        emitProgress('failed', null)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_DELETE,
    (_event, contactId: string) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      const userId = getCurrentUserId()
      contactRepo.deleteContact(contactId)
      logAudit(userId, 'contact', contactId, 'delete', {})
    }
  )

  try {
    contactRepo.syncContactsFromMeetings(getCurrentUserId())
  } catch (err) {
    console.error('[Contacts] Startup sync failed:', err)
  }
}
