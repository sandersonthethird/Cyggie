import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, extname, basename, resolve as resolvePath } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as contactRepo from '../database/repositories/contact.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import type {
  CompanyEntityType,
  CompanyListFilter,
  CompanyDriveFileRef,
  CompanyPriority,
  CompanyRound,
  CompanyPipelineStage
} from '../../shared/types/company'
import { ingestCompanyEmails } from '../services/company-email-ingest.service'
import { hasDriveFilesScope } from '../calendar/google-auth'
import { listCompanyFilesByDriveFolder } from '../drive/google-drive'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import { readSummary } from '../storage/file-manager'

const companyDriveRootCache = new Map<string, string>()

/**
 * Normalize a value for fuzzy folder matching — same approach as
 * `normalizeLookupValue` in google-drive.ts: lowercase, strip non-alphanumeric.
 */
function normalizeName(value: string | null | undefined): string {
  if (!value) return ''
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Build lookup keys from company name + optional domain, mirroring
 * `companyLookupKeys` in google-drive.ts.
 */
function buildLookupKeys(companyName: string, primaryDomain?: string | null): string[] {
  const keys = new Set<string>()
  const normalizedName = normalizeName(companyName)
  if (normalizedName) keys.add(normalizedName)

  const normalizedDomain = normalizeName(primaryDomain)
  if (normalizedDomain) {
    keys.add(normalizedDomain)
    const domainBase = normalizeName((primaryDomain || '').split('.')[0] || '')
    if (domainBase) keys.add(domainBase)
  }

  return Array.from(keys)
}

function hasFuzzyKeyOverlap(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (!a || !b) return false
  if (a === b) return true
  if (a.length < 5 || b.length < 5) return false
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
          const normalized = normalizeName(entry.name)
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
          const normalizedFileName = normalizeName(entry.name.replace(/\.[^.]+$/, ''))
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

  ipcMain.handle(IPC_CHANNELS.COMPANY_DELETE, (_event, companyId: string) => {
    if (!companyId?.trim()) throw new Error('companyId is required')
    const userId = getCurrentUserId()
    const company = companyRepo.getCompany(companyId)
    if (!company) throw new Error('Company not found')
    companyRepo.deleteCompany(companyId)
    logAudit(userId, 'company', companyId, 'delete', {
      canonicalName: company.canonicalName
    })
    return { success: true }
  })

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
    IPC_CHANNELS.COMPANY_LINK_CONTACT,
    (_event, companyId: string, contactId: string) => {
      if (!companyId) throw new Error('companyId is required')
      if (!contactId) throw new Error('contactId is required')
      companyRepo.linkContactToCompany(companyId, contactId)
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
      return result
    })
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
}
