import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as contactRepo from '../database/repositories/contact.repo'
import { generateKeyTakeaways } from '../llm/contact-key-takeaways'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as contactDecisionLogRepo from '../database/repositories/contact-decision-log.repo'
import { ingestContactEmails, cancelContactEmailIngest } from '../services/company-email-ingest.service'
import {
  enrichContactsViaWebLookup,
  mergeContactEnrichmentResults
} from '../services/contact-web-enrichment'
import {
  enrichContactFromLinkedIn,
  enrichContactsFromLinkedInBatch,
} from '../services/linkedin-enrichment.service'
import { getContactSummaryUpdateProposalsFromMeetingId } from '../services/contact-summary-sync.service'
import {
  findLinkedInUrlWithCascade,
  findLinkedInUrlsForContactsBatch,
  ExaDiscoveryError,
} from '../services/exa-linkedin-discovery.service'
import { getCredential } from '../security/credentials'
import { getProvider } from '../llm/provider-factory'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import { LinkedInEnrichError } from '../../shared/types/contact'
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

// In-flight guards for LinkedIn enrichment
let linkedinEnrichInFlight = false
let exaBatchAbortController: AbortController | null = null
let linkedinBatchAbortController: AbortController | null = null

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
      companyId?: string
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
    (_event, contactId: string, companyName: string | null) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      const userId = getCurrentUserId()

      if (!companyName?.trim()) {
        const updated = contactRepo.setContactPrimaryCompany(contactId, null, userId)
        logAudit(userId, 'contact', contactId, 'update', { primaryCompanyId: null })
        return updated
      }

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
    IPC_CHANNELS.CONTACT_UPDATE_EMAIL,
    (_event, { contactId, oldEmail, newEmail }: { contactId: string; oldEmail: string; newEmail: string }) => {
      if (!contactId?.trim()) throw new Error('contactId is required')
      if (!oldEmail?.trim()) throw new Error('oldEmail is required')
      if (!newEmail?.trim()) throw new Error('newEmail is required')
      const userId = getCurrentUserId()
      const updated = contactRepo.updateContactEmail(contactId, oldEmail, newEmail, userId)
      logAudit(userId, 'contact', contactId, 'update', { oldEmail, newEmail })
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
    IPC_CHANNELS.CONTACT_ENRICH_LINKEDIN,
    async (_event, contactId: string) => {
      if (!contactId?.trim()) return { success: false, errorCode: 'invalid_input', message: 'contactId is required' }
      if (linkedinEnrichInFlight) {
        return { success: false, errorCode: 'in_flight', message: 'LinkedIn enrichment already in progress' }
      }
      linkedinEnrichInFlight = true
      try {
        const result = await enrichContactFromLinkedIn(contactId, getCurrentUserId())
        logAudit(getCurrentUserId(), 'contact', contactId, 'update', { action: 'enrich-linkedin', ...result.summary })
        return { success: true, contact: result.contact, summary: result.summary }
      } catch (err) {
        if (err instanceof LinkedInEnrichError) {
          console.error(`[LinkedIn Enrich] ${err.code}:`, err.message)
          return { success: false, errorCode: err.code, message: err.message }
        }
        console.error('[LinkedIn Enrich] Unexpected error:', err)
        return { success: false, errorCode: 'unknown', message: toErrorMessage(err) }
      } finally {
        linkedinEnrichInFlight = false
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_LINKEDIN_OPEN_LOGIN, () => {
    const win = new BrowserWindow({
      show: true,
      width: 1000,
      height: 700,
      title: 'Sign in to LinkedIn — Cyggie',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // NOTE: no partition — must share default session so LinkedIn cookies persist
      },
    })
    win.loadURL('https://www.linkedin.com/login').catch(() => { /* ignore */ })
    win.webContents.on('did-navigate', (_e, url) => {
      if (!url.includes('/login') && !url.includes('/checkpoint')) {
        setTimeout(() => { try { win.close() } catch { /* already closed */ } }, 2000)
      }
    })
    return { opened: true }
  })

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_ENRICH_LINKEDIN_BATCH,
    async (event, { contactIds }: { contactIds: string[] }) => {
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return { enriched: 0, failed: 0, loginRequired: false, paused: false }
      }
      linkedinBatchAbortController = new AbortController()
      const userId = getCurrentUserId()
      const result = await enrichContactsFromLinkedInBatch(
        contactIds,
        userId,
        linkedinBatchAbortController.signal,
        (current, total, progress) => {
          event.sender.send(IPC_CHANNELS.CONTACT_ENRICH_LINKEDIN_BATCH_PROGRESS, { current, total, ...progress })
        }
      )
      logAudit(userId, 'contact', 'linkedin-batch', 'update', result)
      return result
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_ENRICH_LINKEDIN_BATCH_CANCEL, () => {
    linkedinBatchAbortController?.abort()
    return { cancelled: true }
  })

  // ---------------------------------------------------------------------------
  // Exa LinkedIn URL discovery
  // ---------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS.CONTACT_FIND_LINKEDIN_URL, async (_event, contactId: string) => {
    if (!contactId?.trim()) return { success: false, errorCode: 'invalid_input', message: 'contactId is required' }
    const exaApiKey = getCredential('exaApiKey')
    if (!exaApiKey) return { success: false, errorCode: 'no_exa_key', message: 'Add an Exa API key in Settings → AI & Transcription' }
    const contact = contactRepo.getContact(contactId)
    if (!contact) return { success: false, errorCode: 'not_found', message: 'Contact not found' }
    if (contact.linkedinUrl) {
      return { success: true, foundUrl: contact.linkedinUrl, contactName: contact.fullName, alreadyHadUrl: true }
    }
    const userId = getCurrentUserId()
    try {
      const foundUrl = await findLinkedInUrlWithCascade(contact, exaApiKey)
      logAudit(userId, 'contact', contactId, 'update', { action: 'find-linkedin-url', found: !!foundUrl })
      return { success: true, foundUrl, contactName: contact.fullName, alreadyHadUrl: false }
    } catch (err) {
      if (err instanceof ExaDiscoveryError) {
        return { success: false, errorCode: err.code, message: err.message }
      }
      return { success: false, errorCode: 'unknown', message: toErrorMessage(err) }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.CONTACT_FIND_LINKEDIN_URL_BATCH,
    async (event, { contactIds }: { contactIds: string[] }) => {
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return { success: true, found: 0, notFound: 0, skipped: 0, results: [] }
      }
      const exaApiKey = getCredential('exaApiKey')
      if (!exaApiKey) return { success: false, errorCode: 'no_exa_key', message: 'Add an Exa API key in Settings → AI & Transcription' }
      exaBatchAbortController = new AbortController()
      const userId = getCurrentUserId()
      try {
        const result = await findLinkedInUrlsForContactsBatch(
          contactIds,
          exaApiKey,
          exaBatchAbortController.signal,
          (progress) => {
            event.sender.send(IPC_CHANNELS.CONTACT_FIND_LINKEDIN_URL_BATCH_PROGRESS, progress)
          },
          userId
        )
        return { success: true, ...result }
      } catch (err) {
        if (err instanceof ExaDiscoveryError) {
          return { success: false, errorCode: err.code, message: err.message }
        }
        return { success: false, errorCode: 'unknown', message: toErrorMessage(err) }
      } finally {
        exaBatchAbortController = null
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_FIND_LINKEDIN_URL_BATCH_CANCEL, () => {
    exaBatchAbortController?.abort()
    return { cancelled: true }
  })

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

  // Contact decision log CRUD
  ipcMain.handle(IPC_CHANNELS.CONTACT_DECISION_LOG_LIST, (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')
    return contactDecisionLogRepo.listContactDecisionLogs(contactId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_DECISION_LOG_GET, (_event, logId: string) => {
    if (!logId) throw new Error('logId is required')
    return contactDecisionLogRepo.getContactDecisionLog(logId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_DECISION_LOG_CREATE, (_event, data: {
    contactId: string
    decisionType: string
    decisionDate: string
    decisionOwner?: string | null
    rationale?: string[]
    nextSteps?: import('../../shared/types/company').DecisionNextStep[]
  }) => {
    if (!data?.contactId) throw new Error('contactId is required')
    const userId = getCurrentUserId()
    return contactDecisionLogRepo.createContactDecisionLog(data, userId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_DECISION_LOG_UPDATE, (_event, logId: string, data: Record<string, unknown>) => {
    if (!logId) throw new Error('logId is required')
    const userId = getCurrentUserId()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return contactDecisionLogRepo.updateContactDecisionLog(logId, data as any, userId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_DECISION_LOG_DELETE, (_event, logId: string) => {
    if (!logId) throw new Error('logId is required')
    return contactDecisionLogRepo.deleteContactDecisionLog(logId)
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_ENRICH_FROM_MEETING, async (_event, meetingId: string) => {
    if (!meetingId) return []
    try {
      const provider = getProvider()
      return await getContactSummaryUpdateProposalsFromMeetingId(meetingId, provider)
    } catch (err) {
      console.error('[Contact AutoFill] On-demand enrichment failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONTACT_KEY_TAKEAWAYS_GENERATE, async (_event, contactId: string) => {
    if (!contactId) throw new Error('contactId is required')

    const sendKtProgress = (payload: { contactId: string; chunk: string } | null): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.CONTACT_KEY_TAKEAWAYS_PROGRESS, payload)
        }
      }
    }

    try {
      const generated = await generateKeyTakeaways(contactId, (chunk) => {
        sendKtProgress({ contactId, chunk })
      })

      sendKtProgress(null) // completion sentinel

      contactRepo.updateContact(contactId, { keyTakeaways: generated }, getCurrentUserId())
      console.log('[KT] Generated and saved for contact:', contactId)
      return { success: true, contactId, keyTakeaways: generated }
    } catch (err) {
      console.error('[KT] Generation failed for contact:', contactId, err)
      sendKtProgress(null) // ensure sentinel fires on error too
      throw err
    }
  })

  try {
    contactRepo.syncContactsFromMeetings(getCurrentUserId())
  } catch (err) {
    console.error('[Contacts] Startup sync failed:', err)
  }
}
