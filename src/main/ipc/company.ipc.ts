import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, extname, basename, resolve as resolvePath } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { normalizeToken } from '../utils/string-utils'
import * as companyRepo from '@cyggie/db/sqlite/repositories'
import { upsert as upsertCompanyCache } from '@cyggie/db/sqlite/repositories/company.repo'
import * as contactRepo from '@cyggie/db/sqlite/repositories'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import * as decisionRepo from '@cyggie/db/sqlite/repositories/company-decision-log.repo'
import { autoAddDecisionToDigest } from '@cyggie/db/sqlite/repositories/partner-meeting.repo'
import type {
  CompanyEntityType,
  CompanyListFilter,
  CompanyDriveFileRef,
  CompanyPriority,
  CompanyRound,
  CompanyPipelineStage,
  CompanyDedupDecision
} from '../../shared/types/company'
import { SYSTEM_DECISION_TYPE_STAGE_CHANGE } from '../../shared/types/company'
import { summaryFileExists } from '../storage/file-manager'
import { ingestCompanyEmails, cancelCompanyEmailIngest } from '../services/company-email-ingest.service'
import { backfillEmailsAfterIngest } from '../services/email-sync-backfill.service'
import {
  getCompanyEnrichmentProposalsFromMeetings,
  getCompanyEnrichmentProposalsFromNotes,
  getCompanyEnrichmentProposalsFromEmails,
} from '@cyggie/services/company-summary-sync.service'
import { extractFromPdf, extractFromUrl, PitchDeckError } from '../services/pitch-deck-ingestion.service'
import { generateCompanyKeyTakeaways } from '@cyggie/services/llm/company-key-takeaways'
import { runPitchDeckAnalysis } from '../services/pitch-deck-analysis.service'
import { queueStubEnrichment } from '@cyggie/services/stub-enrichment.service'
import { makeSyncedEntityNotesRepo } from '@cyggie/db/sqlite/repositories'

const _companyNotesRepo = makeSyncedEntityNotesRepo('company_id')
import type { PitchDeckIngestPayload, PitchDeckExtractionResult } from '../../shared/types/pitch-deck'
import { hasDriveFilesScope } from '../calendar/google-auth'
import { listCompanyFilesByDriveFolder } from '../drive/google-drive'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '@cyggie/db/sqlite/repositories/audit.repo'
import { purgeEntityRemote } from '../services/sync-bootstrap'
import { readSummary } from '../storage/file-manager'
import { getProvider } from '@cyggie/services/llm/provider-factory'

const companyDriveRootCache = new Map<string, string>()

// normalizeName is now normalizeToken from string-utils (same logic, shared)

/**
 * Build lookup keys from company name + optional domain, mirroring
 * `companyLookupKeys` in google-drive.ts.
 */
function buildLookupKeys(companyName: string, primaryDomain?: string | null): string[] {
  const keys = new Set<string>()
  const normalizedName = normalizeToken(companyName)
  if (normalizedName) keys.add(normalizedName)

  const normalizedDomain = normalizeToken(primaryDomain || '')
  if (normalizedDomain) {
    keys.add(normalizedDomain)
    const domainBase = normalizeToken((primaryDomain || '').split('.')[0] || '')
    if (domainBase) keys.add(domainBase)
  }

  return Array.from(keys)
}

function hasFuzzyKeyOverlap(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (!a || !b) return false
  if (a === b) return true
  if (a.length < 5 || b.length < 5) {
    // For short strings, use startsWith to avoid mid-string false positives
    // (e.g. "amma" should NOT match "gamma", but SHOULD match "ammadeck")
    if (Math.min(a.length, b.length) < 3) return false
    return a.startsWith(b) || b.startsWith(a)
  }
  return a.includes(b) || b.includes(a)
}

function parseDriveRootFolderRefs(raw: string): string[] {
  const values = raw
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean)

  const unique: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

interface ScanResult {
  companyFolder: string | null
  nameMatchedFiles: CompanyDriveFileRef[]
}

/**
 * Single-pass BFS scan of `rootDir` (depth-limited to 3) that simultaneously:
 * 1. Finds a folder matching the company name/domain (exact preferred over fuzzy)
 * 2. Collects files whose names match the company lookup keys
 *
 * Files inside the matched company folder are excluded from `nameMatchedFiles`
 * since those are listed separately via `listDirContents`.
 */
async function scanCompanyRoot(
  rootDir: string,
  companyName: string,
  primaryDomain?: string | null
): Promise<ScanResult> {
  const MAX_DEPTH = 3
  const lookupKeys = buildLookupKeys(companyName, primaryDomain)
  if (lookupKeys.length === 0) return { companyFolder: null, nameMatchedFiles: [] }

  const start = Date.now()
  const queue: Array<{ path: string; depth: number }> = [{ path: rootDir, depth: 0 }]
  let exactFolderMatch: string | null = null
  let fuzzyFolderMatch: string | null = null
  const matchedFiles: CompanyDriveFileRef[] = []
  let dirsChecked = 0

  while (queue.length > 0) {
    const { path: dir, depth } = queue.shift()!
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      dirsChecked++

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
          const normalized = normalizeToken(entry.name)
          if (normalized) {
            // Exact normalized folder match
            if (!exactFolderMatch && lookupKeys.includes(normalized)) {
              exactFolderMatch = fullPath
              console.log(`[Company Files] Found exact match "${entry.name}" at depth ${depth} (${dirsChecked} dirs in ${Date.now() - start}ms)`)
            }
            // Fuzzy folder match (first one wins)
            if (!exactFolderMatch && !fuzzyFolderMatch) {
              for (const key of lookupKeys) {
                if (hasFuzzyKeyOverlap(normalized, key)) {
                  fuzzyFolderMatch = fullPath
                  break
                }
              }
            }
          }
          // Recurse into subdirectories within depth limit
          if (depth + 1 < MAX_DEPTH) {
            queue.push({ path: fullPath, depth: depth + 1 })
          }
        } else {
          // Check file name against lookup keys
          const normalizedFileName = normalizeToken(entry.name.replace(/\.[^.]+$/, ''))
          if (!normalizedFileName) continue

          const matches = lookupKeys.some((key) => hasFuzzyKeyOverlap(normalizedFileName, key))
          if (!matches) continue

          let fileStat: Awaited<ReturnType<typeof stat>> | null = null
          try {
            fileStat = await stat(fullPath)
          } catch { /* ignore */ }

          matchedFiles.push({
            id: fullPath,
            name: entry.name,
            mimeType: extname(entry.name).slice(1) || 'file',
            modifiedAt: fileStat?.mtime?.toISOString() ?? null,
            webViewLink: null,
            sizeBytes: fileStat?.size ?? null,
            parentFolderName: basename(dir)
          })
        }
      }
    } catch {
      continue
    }
  }

  const companyFolder = exactFolderMatch || fuzzyFolderMatch
  console.log(`[Company Files] Scan done: ${dirsChecked} dirs in ${Date.now() - start}ms, keys=${JSON.stringify(lookupKeys)}, folder=${companyFolder ? (exactFolderMatch ? 'exact' : 'fuzzy') : 'none'}, nameMatches=${matchedFiles.length}`)

  // Filter out files that live inside the company folder (listed separately)
  let nameMatchedFiles = matchedFiles
  if (companyFolder) {
    const folderPrefix = resolvePath(companyFolder).toLowerCase()
    nameMatchedFiles = matchedFiles.filter(
      (f) => !resolvePath(f.id).toLowerCase().startsWith(folderPrefix)
    )
  }

  return { companyFolder, nameMatchedFiles }
}

interface LocalFilesResult {
  companyRoot: string
  files: CompanyDriveFileRef[]
}

async function listDirContents(dirPath: string): Promise<CompanyDriveFileRef[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const results: CompanyDriveFileRef[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dirPath, entry.name)
      let fileStat: Awaited<ReturnType<typeof stat>> | null = null
      try {
        fileStat = await stat(fullPath)
      } catch { /* ignore */ }

      const isDir = entry.isDirectory()
      results.push({
        id: fullPath,
        name: entry.name,
        mimeType: isDir ? 'folder' : (extname(entry.name).slice(1) || 'file'),
        modifiedAt: fileStat?.mtime?.toISOString() ?? null,
        webViewLink: null,
        sizeBytes: isDir ? null : (fileStat?.size ?? null),
        parentFolderName: basename(dirPath)
      })
    }

    return results.sort((a, b) => {
      const aDir = a.mimeType === 'folder' ? 0 : 1
      const bDir = b.mimeType === 'folder' ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name)
    })
  } catch {
    return []
  }
}

async function listLocalCompanyFiles(
  rootDir: string,
  companyName: string,
  primaryDomain?: string | null,
  browsePath?: string
): Promise<LocalFilesResult | null> {
  if (!existsSync(rootDir)) return null

  const { companyFolder, nameMatchedFiles } = await scanCompanyRoot(rootDir, companyName, primaryDomain)

  // When browsing into a subfolder, only show that folder's contents
  if (browsePath && companyFolder) {
    const targetDir = resolvePath(companyFolder, browsePath)
    const resolved = resolvePath(targetDir)
    const companyResolved = resolvePath(companyFolder)

    // Case-insensitive check for macOS/Windows filesystem compatibility
    if (!resolved.toLowerCase().startsWith(companyResolved.toLowerCase())) {
      console.warn(`[chat-files] reject browsePath path=${browsePath} reason=outside-root companyRoot=${companyFolder}`)
      return { companyRoot: companyFolder, files: [] }
    }

    return {
      companyRoot: companyFolder,
      files: await listDirContents(resolved)
    }
  }

  // Top-level: combine company folder contents + name-matched files from elsewhere
  const folderFiles = companyFolder ? await listDirContents(companyFolder) : []

  // Deduplicate by full path (id)
  const seenIds = new Set(folderFiles.map((f) => f.id))
  const merged = [...folderFiles]
  for (const file of nameMatchedFiles) {
    if (!seenIds.has(file.id)) {
      seenIds.add(file.id)
      merged.push(file)
    }
  }

  if (merged.length === 0 && !companyFolder) return null

  return {
    companyRoot: companyFolder || rootDir,
    files: merged
  }
}

export function registerCompanyHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_LIST,
    (_event, filter?: CompanyListFilter) => {
      return companyRepo.listCompanies(filter)
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_COUNT_STUBS, () => {
    return companyRepo.countStubCompanies()
  })

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
      primaryContact?: { fullName: string; email: string }
    }) => {
      if (!data?.canonicalName?.trim()) {
        throw new Error('Company name is required')
      }
      const userId = getCurrentUserId()
      const created = companyRepo.createCompany(data, userId)
      logAudit(userId, 'company', created.id, 'create', data)

      if (data.primaryContact?.fullName?.trim() && data.primaryContact?.email?.trim()) {
        try {
          const contact = contactRepo.createContact({
            fullName: data.primaryContact.fullName.trim(),
            email: data.primaryContact.email.trim()
          }, userId)
          companyRepo.setCompanyPrimaryContact(created.id, contact.id)
        } catch (err) {
          console.error('[COMPANY_CREATE] Failed to create primary contact:', err)
        }
      }

      return created
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_UPDATE,
    (_event, companyId: string, updates: Record<string, unknown>) => {
      if (!companyId) throw new Error('companyId is required')
      const userId = getCurrentUserId()
      const db = getDatabase()

      // Peel off non-column keys that require special handling
      let remaining: Record<string, unknown> = { ...updates }

      if ('coInvestorsList' in remaining) {
        try {
          companyRepo.setCompanyInvestors(companyId, 'co_investor', (remaining.coInvestorsList as Array<{ id: string; name: string }>) ?? [])
        } catch (err) {
          console.error('[COMPANY_UPDATE] Failed to update coInvestorsList:', err)
        }
        const { coInvestorsList: _, ...rest } = remaining
        remaining = rest
      }
      if ('priorInvestorsList' in remaining) {
        try {
          companyRepo.setCompanyInvestors(companyId, 'prior_investor', (remaining.priorInvestorsList as Array<{ id: string; name: string }>) ?? [])
        } catch (err) {
          console.error('[COMPANY_UPDATE] Failed to update priorInvestorsList:', err)
        }
        const { priorInvestorsList: _, ...rest } = remaining
        remaining = rest
      }
      if ('subsequentInvestorsList' in remaining) {
        try {
          companyRepo.setCompanyInvestors(companyId, 'subsequent_investor', (remaining.subsequentInvestorsList as Array<{ id: string; name: string }>) ?? [])
        } catch (err) {
          console.error('[COMPANY_UPDATE] Failed to update subsequentInvestorsList:', err)
        }
        const { subsequentInvestorsList: _, ...rest } = remaining
        remaining = rest
      }

      // Phase 2B: when a leadInvestorCompanyId patch arrives, also keep the
      // legacy `lead_investor` TEXT field in sync (for any code path that
      // still reads the text fallback). The FK column itself is updated
      // by the regular updateCompany() field-map handling.
      if ('leadInvestorCompanyId' in remaining) {
        const newId = remaining.leadInvestorCompanyId as string | null
        if (newId) {
          const row = db.prepare('SELECT canonical_name FROM org_companies WHERE id = ?').get(newId) as
            | { canonical_name: string }
            | undefined
          if (row) remaining = { ...remaining, leadInvestor: row.canonical_name }
        } else {
          remaining = { ...remaining, leadInvestor: null }
        }
      }

      const newStage = 'pipelineStage' in remaining ? (remaining.pipelineStage as string | null) : undefined

      // Capture previous stage BEFORE any mutation so the Stage Change auto-log
      // below captures the real transition. Only needed when the patch includes
      // pipelineStage — otherwise prevStage is unused.
      const prevStage = 'pipelineStage' in remaining
        ? ((db.prepare('SELECT pipeline_stage FROM org_companies WHERE id = ?').get(companyId) as
            | { pipeline_stage: string | null }
            | undefined)?.pipeline_stage ?? null)
        : null
      const stageChanging = 'pipelineStage' in remaining && (newStage ?? null) !== prevStage

      // Stage-driven side effects (matched to terminal-stage semantics).
      // Pass:      clear priority (it's a closed deal, priority no longer relevant)
      // Portfolio: auto-promote entity type to 'portfolio' so the two redundant
      //            fields stay in sync no matter which surface set the stage.
      if (newStage === 'pass') {
        remaining = { ...remaining, priority: null }
      }
      if (newStage === 'portfolio') {
        remaining = { ...remaining, entityType: 'portfolio' }
      }

      // Atomic stage update + Stage Change decision log. If the log INSERT
      // throws, the stage update rolls back — prevents the company landing in
      // 'pass' with no log, which would silently exclude it from Recent Pass
      // (NULL semantics in the SQL filter). better-sqlite3 supports nesting
      // (companyRepo.updateCompany has its own withSync txn → savepoint).
      const updated = db.transaction(() => {
        const u = companyRepo.updateCompany(companyId, remaining, userId)
        if (u && stageChanging) {
          const log = decisionRepo.createCompanyDecisionLog({
            companyId,
            decisionType: SYSTEM_DECISION_TYPE_STAGE_CHANGE,
            decisionDate: new Date().toISOString(),
            rationale: [`Moved from ${prevStage ?? 'Sourced'} to ${newStage ?? 'Sourced'}`],
          }, userId)
          logAudit(userId, 'company_decision_log', log.id, 'create', {
            auto: true, from: prevStage, to: newStage,
          })
        }
        return u
      })()

      if (updated) {
        logAudit(userId, 'company', companyId, 'update', updates)

        // Sync email-domain cache when canonical name changes, so meeting chips update.
        if ('canonicalName' in updates) {
          const newName = (updates.canonicalName as string)?.trim()
          if (newName && updated.primaryDomain) {
            upsertCompanyCache(updated.primaryDomain, newName)
          }
        }

        // Digest auto-add fires AFTER the txn commits — digest write failures
        // shouldn't roll back the stage change. autoAddDecisionToDigest has
        // its own internal try/catch.
        if (stageChanging) {
          autoAddDecisionToDigest(
            companyId,
            `${SYSTEM_DECISION_TYPE_STAGE_CHANGE}: Moved from ${prevStage ?? 'Sourced'} to ${newStage ?? 'Sourced'}`,
          )
        }
      }

      return updated
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_MERGE,
    (_event, targetCompanyId: string, sourceCompanyId: string, fieldOverrides?: Record<string, unknown>) => {
      if (!targetCompanyId?.trim() || !sourceCompanyId?.trim()) {
        throw new Error('Both targetCompanyId and sourceCompanyId are required')
      }
      const userId = getCurrentUserId()
      const db = getDatabase()

      // Capture names before the merge deletes the source row
      const sourceRow = db
        .prepare('SELECT canonical_name FROM org_companies WHERE id = ? LIMIT 1')
        .get(sourceCompanyId) as { canonical_name: string } | undefined
      const targetRow = db
        .prepare('SELECT canonical_name FROM org_companies WHERE id = ? LIMIT 1')
        .get(targetCompanyId) as { canonical_name: string } | undefined

      const result = companyRepo.mergeCompanies(targetCompanyId, sourceCompanyId, fieldOverrides)

      // Clean up stale search sources so the old name no longer appears in results
      if (sourceRow && targetRow) {
        // 1. Remap domain-cache entries (case-insensitive to catch casing variants)
        db.prepare('UPDATE companies SET display_name = ? WHERE display_name = ? COLLATE NOCASE')
          .run(targetRow.canonical_name, sourceRow.canonical_name)

        // 2. Replace old name in meetings.companies JSON arrays
        db.prepare(`
          UPDATE meetings
          SET companies = REPLACE(companies, ?, ?)
          WHERE companies LIKE ?
        `).run(
          JSON.stringify(sourceRow.canonical_name).slice(1, -1),
          JSON.stringify(targetRow.canonical_name).slice(1, -1),
          `%${sourceRow.canonical_name}%`
        )
      }

      logAudit(userId, 'company', targetCompanyId, 'update', {
        mergedFrom: sourceCompanyId,
        relinked: result.relinked,
        fieldOverrideKeys: fieldOverrides ? Object.keys(fieldOverrides) : []
      })
      logAudit(userId, 'company', sourceCompanyId, 'delete', {
        mergedInto: targetCompanyId
      })
      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_MERGE_PREVIEW,
    (_event, targetCompanyId: string, sourceCompanyId: string) => {
      if (!targetCompanyId?.trim() || !sourceCompanyId?.trim()) {
        throw new Error('Both targetCompanyId and sourceCompanyId are required')
      }
      return companyRepo.getCompanyMergePreview(targetCompanyId, sourceCompanyId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_DEDUP_SUSPECTED,
    (_event, limit?: number) => {
      return companyRepo.listSuspectedDuplicateCompanies(limit)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_DEDUP_APPLY,
    (_event, decisions: CompanyDedupDecision[]) => {
      if (!Array.isArray(decisions)) {
        throw new Error('decisions must be an array')
      }
      const userId = getCurrentUserId()
      const result = companyRepo.applyCompanyDedupDecisions(decisions, userId)
      logAudit(userId, 'company', 'dedup-bulk', 'update', {
        reviewedGroups: result.reviewedGroups,
        mergedGroups: result.mergedGroups,
        deletedGroups: result.deletedGroups,
        skippedGroups: result.skippedGroups,
        mergedCompanies: result.mergedCompanies,
        deletedCompanies: result.deletedCompanies,
        failures: result.failures.slice(0, 20)
      })
      return result
    }
  )

  // Phase 3: "Delete" is now a SOFT delete (moves to the Recycle Bin) that syncs
  // to teammates via field-LWW. Permanent removal is the admin purge (Phase 3 C2).
  ipcMain.handle(IPC_CHANNELS.COMPANY_DELETE, (_event, companyId: string) => {
    if (!companyId?.trim()) throw new Error('companyId is required')
    const userId = getCurrentUserId()
    const company = companyRepo.getCompany(companyId)
    if (!company) throw new Error('Company not found')
    companyRepo.softDeleteCompany(companyId, userId)
    logAudit(userId, 'company', companyId, 'delete', {
      canonicalName: company.canonicalName
    })
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_RESTORE, (_event, companyId: string) => {
    if (!companyId?.trim()) throw new Error('companyId is required')
    const userId = getCurrentUserId()
    companyRepo.restoreCompany(companyId, userId)
    logAudit(userId, 'company', companyId, 'restore', null)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_LIST_DELETED, () => {
    return companyRepo.listDeletedCompanies()
  })

  // Admin hard-purge — gateway-enforced (requireAdmin). Removes the Neon row +
  // writes a tombstone; the triggered pull hard-deletes this device's copy.
  ipcMain.handle(IPC_CHANNELS.COMPANY_PURGE, async (_event, companyId: string) => {
    if (!companyId?.trim()) throw new Error('companyId is required')
    const userId = getCurrentUserId()
    const purged = await purgeEntityRemote('company', companyId)
    logAudit(userId, 'company', companyId, 'delete', { purged: true })
    return { purged }
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_FIND_OR_CREATE,
    (_event, companyName: string) => {
      if (!companyName?.trim()) throw new Error('companyName is required')
      const userId = getCurrentUserId()
      const company = companyRepo.getOrCreateCompanyByName(companyName.trim(), userId)

      // Phase 4: if find-or-create produced (or returned) a sparse stub,
      // fire-and-forget background LLM enrichment to fill in entity_type,
      // primary_domain, and description. Throttled + deduped inside the service.
      const isSparseStub =
        company.entityType === 'unknown' &&
        !company.primaryDomain &&
        !company.description
      if (isSparseStub) {
        queueStubEnrichment(company.id)
      }

      return company
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
    return companyRepo.listCompanyMeetings(companyId).map((m) => ({
      ...m,
      hasReadableSummary: summaryFileExists(m.summaryPath),
      hasSummaryDriveId: !!m.summaryDriveId,
    }))
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_CONTACTS, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    const current = companyRepo.listCompanyContacts(companyId).map((c) => ({ ...c, isPastEmployee: false }))
    const past = contactRepo.listPastEmployeeContacts(companyId)
    // Dedup by id — current employee entry wins
    const seen = new Set(current.map((c) => c.id))
    const pastMapped = past
      .filter((c) => !seen.has(c.id))
      .map((c) => ({
        id: c.id,
        fullName: c.fullName,
        email: c.email,
        title: c.title,
        contactType: c.contactType,
        linkedinUrl: c.linkedinUrl,
        isPrimary: false,
        isPastEmployee: true,
        meetingCount: c.meetingCount,
        lastInteractedAt: c.lastTouchpoint ?? null,
        updatedAt: c.updatedAt,
      }))
    return [...current, ...pastMapped]
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_SET_PRIMARY_CONTACT,
    (_event, companyId: string, contactId: string) => {
      if (!companyId) throw new Error('companyId is required')
      if (!contactId) throw new Error('contactId is required')
      const userId = getCurrentUserId()
      companyRepo.setCompanyPrimaryContact(companyId, contactId)
      // Also update the contact's primary company field so it appears on the contact record
      try {
        contactRepo.setContactPrimaryCompany(contactId, companyId, userId)
      } catch (err) {
        console.warn('[COMPANY_SET_PRIMARY_CONTACT] Could not update contact primary company:', err)
      }
      return { success: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_CLEAR_PRIMARY_CONTACT,
    (_event, companyId: string, contactId: string) => {
      if (!companyId) throw new Error('companyId is required')
      const userId = getCurrentUserId()
      companyRepo.clearCompanyPrimaryContact(companyId)
      // Ensure the contact has an explicit org_company_contacts row before clearing
      // primary_company_id — contacts linked only via primary_company_id would otherwise
      // disappear from the company's contacts list entirely.
      if (contactId) {
        companyRepo.linkContactToCompany(companyId, contactId)
      }
      // Clear the contact's primary company if it points back to this company
      try {
        contactRepo.setContactPrimaryCompany(contactId, null, userId)
      } catch (err) {
        console.warn('[COMPANY_CLEAR_PRIMARY_CONTACT] Could not clear contact primary company:', err)
      }
      return { success: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_LINK_CONTACT,
    (_event, companyId: string, contactId: string) => {
      if (!companyId) throw new Error('companyId is required')
      if (!contactId) throw new Error('contactId is required')
      companyRepo.linkContactToCompany(companyId, contactId)
      return { success: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_UNLINK_CONTACT,
    (_event, companyId: string, contactId: string) => {
      if (!companyId) throw new Error('companyId is required')
      if (!contactId) throw new Error('contactId is required')
      companyRepo.unlinkContactFromCompany(companyId, contactId)
      return { success: true }
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_EMAILS, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.listCompanyEmails(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_EMAIL_INGEST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return ingestCompanyEmails(companyId).then((result) => {
      console.log('[company-email-ingest]', result)
      // Part B — push freshly-ingested emails to Neon so the gateway/mobile
      // chat context can include them (idempotent; no-op if nothing new).
      backfillEmailsAfterIngest(getCurrentUserId())
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_EMAIL_INGEST_CANCEL, (_event, companyId: string) => {
    cancelCompanyEmailIngest(companyId)
    return { cancelled: true }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_EMAIL_UNLINK, (_event, companyId: string, threadGroups: string[]) => {
    if (!companyId || !Array.isArray(threadGroups) || threadGroups.length === 0) return { deleted: 0 }
    return companyRepo.deleteCompanyEmailLinks(companyId, threadGroups)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_FILES, async (_event, companyId: string, browsePath?: string) => {
    const empty = { companyRoot: null as string | null, files: [] as CompanyDriveFileRef[] }
    try {
      if (!companyId) return empty

      const company = companyRepo.getCompany(companyId)
      if (!company) return empty

      // Local filesystem path (preferred when configured)
      const localRoot = (settingsRepo.getSetting('companyLocalFilesRoot') || '').trim()
      if (localRoot) {
        console.log(`[Company Files] Local root: "${localRoot}", company: "${company.canonicalName}", domain: "${company.primaryDomain || ''}"`)
        const result = await listLocalCompanyFiles(localRoot, company.canonicalName, company.primaryDomain, browsePath)
        if (result && result.files.length > 0) {
          console.log(`[Company Files] Local found ${result.files.length} files in ${result.companyRoot}`)
          return result
        }
        console.log('[Company Files] Local returned no files, falling through to Drive')
      }

      // Google Drive fallback (or primary when local root is not configured)
      if (!hasDriveFilesScope()) {
        console.log('[Company Files] No Drive files scope — returning empty')
        return empty
      }
      const rootFolderRefs = parseDriveRootFolderRefs(settingsRepo.getSetting('companyDriveRootFolder') || '')
      if (rootFolderRefs.length === 0) {
        console.log('[Company Files] No Drive root folder configured — returning empty')
        return empty
      }

      const cachedRootRef = companyDriveRootCache.get(company.id)
      const orderedRootRefs =
        cachedRootRef && rootFolderRefs.includes(cachedRootRef)
          ? [cachedRootRef, ...rootFolderRefs.filter((ref) => ref !== cachedRootRef)]
          : rootFolderRefs

      console.log(`[Company Files] Trying Google Drive across ${orderedRootRefs.length} root(s)...`)
      for (let index = 0; index < orderedRootRefs.length; index += 1) {
        const rootFolderRef = orderedRootRefs[index]
        try {
          console.log(`[Company Files] Drive root ${index + 1}/${orderedRootRefs.length}: ${rootFolderRef}`)
          const lookup = await listCompanyFilesByDriveFolder(
            rootFolderRef,
            company.canonicalName,
            company.primaryDomain
          )
          const files = Array.isArray(lookup) ? lookup : lookup.files
          console.log(`[Company Files] Drive root ${index + 1}/${orderedRootRefs.length} returned ${files.length} files`)
          if (files.length > 0) {
            companyDriveRootCache.set(company.id, rootFolderRef)
            return { companyRoot: null, files }
          }
        } catch (err) {
          console.warn(`[Company Files] Drive root ${index + 1}/${orderedRootRefs.length} failed:`, err)
        }
      }

      return empty
    } catch (err) {
      console.error('[Company Files] Error:', err)
      return empty
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_FILES_READABLE, async (_event, companyId: string) => {
    const READABLE_EXTS = new Set(['.pdf', '.txt', '.md', '.csv'])
    try {
      if (!companyId) return []
      const company = companyRepo.getCompany(companyId)
      if (!company) return []
      const localRoot = (settingsRepo.getSetting('companyLocalFilesRoot') || '').trim()
      if (!localRoot) return []
      const result = await listLocalCompanyFiles(localRoot, company.canonicalName, company.primaryDomain)
      if (!result || result.files.length === 0) return []
      return result.files.filter((f) => {
        if (f.mimeType === 'folder') return false
        const ext = f.name.includes('.') ? '.' + f.name.split('.').pop()!.toLowerCase() : ''
        return READABLE_EXTS.has(ext)
      })
    } catch (err) {
      console.error('[Company Files Readable] Error:', err)
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_MEETING_SUMMARIES, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    const rows = companyRepo.listCompanyMeetingSummaryPaths(companyId)
    return rows
      .map((row) => {
        const content = readSummary(row.summaryPath)
        if (!content) return null
        return { meetingId: row.meetingId, title: row.title, date: row.date, summary: content }
      })
      .filter(Boolean)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_TIMELINE, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyRepo.listCompanyTimeline(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.EMAIL_GET, (_event, messageId: string) => {
    if (!messageId) throw new Error('messageId is required')
    return companyRepo.getCompanyEmailById(messageId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_FIX_CONCATENATED_NAMES, () => {
    try {
      const userId = getCurrentUserId()
      return companyRepo.fixConcatenatedCompanyNames(userId)
    } catch (err) {
      throw new Error(`Failed to fix company names: ${String(err)}`)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_ENRICH_FROM_MEETINGS,
    async (_event, meetingIds: string[], companyId: string) => {
      if (!meetingIds?.length || !companyId) return { ok: false, reason: 'no_content' as const }
      try {
        const provider = getProvider()
        return await getCompanyEnrichmentProposalsFromMeetings(meetingIds, companyId, provider)
      } catch (err) {
        console.error('[Company Enrich] IPC handler failed:', err)
        return { ok: false, reason: 'llm_failed' as const }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_ENRICH_FROM_NOTES, async (_event, companyId: string) => {
    if (!companyId) return { ok: false, reason: 'no_content' as const }
    try {
      return await getCompanyEnrichmentProposalsFromNotes(companyId, getProvider())
    } catch (err) {
      console.error('[Company Enrich Notes] IPC handler failed:', err)
      return { ok: false, reason: 'llm_failed' as const }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_ENRICH_FROM_EMAILS, async (_event, companyId: string) => {
    if (!companyId) return { ok: false, reason: 'no_content' as const }
    try {
      return await getCompanyEnrichmentProposalsFromEmails(companyId, getProvider())
    } catch (err) {
      console.error('[Company Enrich Emails] IPC handler failed:', err)
      return { ok: false, reason: 'llm_failed' as const }
    }
  })

  // ---------------------------------------------------------------------------
  // Pitch deck ingestion
  // ---------------------------------------------------------------------------

  // Opens a native file picker filtered to PDFs. Returns the selected path or null.
  ipcMain.handle(IPC_CHANNELS.COMPANY_PITCH_DECK_OPEN_DIALOG, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Pitch Deck PDF',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // Ingests a PDF or URL, runs LLM extraction, optionally checks for existing company.
  // Returns PitchDeckIngestResult: { result, existingMatch? } | { error }
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_PITCH_DECK_INGEST,
    async (_event, payload: PitchDeckIngestPayload) => {
      const { source, companyId } = payload
      try {
        const provider = getProvider()

        let result
        if (source.type === 'pdf') {
          result = await extractFromPdf(source.path, provider)
        } else {
          result = await extractFromUrl(source.url, { email: source.email, password: source.password }, provider)
        }

        // Save DocSend email to settings if provided (URL path only)
        if (source.type === 'url' && source.email) {
          settingsRepo.setSetting('pitchDeckEmail', source.email)
        }

        // If enriching an existing company, skip dedup
        if (companyId) {
          return { result }
        }

        // Dedup check for new company creation
        const name   = result.companyName?.trim() ?? null
        const domain = result.domain?.trim() ?? null
        if (name) {
          const existingId = companyRepo.findCompanyIdByNameOrDomain(name, domain)
          if (existingId) {
            const existing = companyRepo.getCompany(existingId)
            if (existing) {
              return {
                result,
                existingMatch: { companyId: existingId, companyName: existing.canonicalName },
              }
            }
          }
        }

        return { result }
      } catch (err) {
        if (err instanceof PitchDeckError) {
          console.warn('[PitchDeck] ingestion failed', { code: err.code, message: err.message })
          return { error: err.message }
        }
        console.error('[PitchDeck] unexpected IPC error', err)
        return { error: 'An unexpected error occurred — please try again' }
      }
    }
  )

  // ---------------------------------------------------------------------------
  // File-based company analysis
  // Runs VC pitch analysis + creates a company note WITHOUT touching partner sync.
  // The renderer decides separately whether to also call PARTNER_MEETING_ITEM_ADD.
  // ---------------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_ANALYZE_FILE,
    async (_event, companyId: string, extractionResult: PitchDeckExtractionResult) => {
      if (!companyId) throw new Error('companyId is required')
      if (!extractionResult) throw new Error('extractionResult is required')

      console.log('[company:analyze-file] starting analysis', {
        companyId,
        companyName: extractionResult.companyName,
        sourceLabel: extractionResult.sourceLabel,
      })

      try {
        const noteContent = await runPitchDeckAnalysis(extractionResult)
        if (!noteContent) {
          console.warn('[company:analyze-file] LLM returned null', { companyId })
          return { noteId: null, error: 'analysis_failed' }
        }

        const companyName = extractionResult.companyName ?? 'Unknown'
        const userId = getCurrentUserId()
        const note = _companyNotesRepo.create(
          { entityId: companyId, title: `File Analysis — ${companyName}`, content: noteContent },
          userId
        )

        console.log('[company:analyze-file] note created', { companyId, noteId: note?.id })
        return { noteId: note?.id ?? null, noteCreatedAt: note?.createdAt ?? new Date().toISOString() }
      } catch (err) {
        console.error('[company:analyze-file] failed', { companyId, err })
        return { noteId: null, error: 'note_creation_failed' }
      }
    }
  )

  // ── Key Takeaways (AI summary) ───────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.COMPANY_KEY_TAKEAWAYS_GENERATE, async (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')

    const sendKtProgress = (payload: { companyId: string; chunk: string } | null): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.COMPANY_KEY_TAKEAWAYS_PROGRESS, payload)
        }
      }
    }

    try {
      const generated = await generateCompanyKeyTakeaways(companyId, (chunk) => {
        sendKtProgress({ companyId, chunk })
      })

      sendKtProgress(null) // completion sentinel

      companyRepo.updateCompany(companyId, { keyTakeaways: generated })
      console.log('[Company KT] Generated and saved for company:', companyId)
      return { success: true, companyId, keyTakeaways: generated }
    } catch (err) {
      console.error('[Company KT] Generation failed for company:', companyId, err)
      sendKtProgress(null) // ensure sentinel fires on error too
      throw err
    }
  })
}
