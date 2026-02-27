import { readFileSync } from 'fs'
import { basename } from 'path'
import { Readable } from 'stream'
import { google, type drive_v3 } from 'googleapis'
import {
  getDriveFilesOAuth2Client,
  getOAuth2Client,
  hasDriveScope,
  isCalendarConnected
} from '../calendar/google-auth'
import type { DriveShareResponse } from '../../shared/types/drive'
import type { CompanyDriveFileRef } from '../../shared/types/company'
import type { DriveFolderRef } from '../../shared/types/drive'

type DriveClient = ReturnType<typeof google.drive>
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

export interface CompanyDriveLookupResult {
  files: CompanyDriveFileRef[]
  matchedFolderRef: string | null
}

// In-memory cache for folder IDs (cleared on app restart)
let appFolderId: string | null = null
let transcriptsFolderId: string | null = null
let summariesFolderId: string | null = null

function getDriveClient(): DriveClient | null {
  const auth = getOAuth2Client()
  if (!auth) return null
  return google.drive({ version: 'v3', auth })
}

function getDriveFilesClient(): DriveClient | null {
  const auth = getDriveFilesOAuth2Client()
  if (!auth) return null
  return google.drive({ version: 'v3', auth })
}

/**
 * Verify that the Drive API is accessible with the current token.
 * Throws a descriptive error if the API is not enabled or the scope is missing.
 */
async function verifyDriveAccess(drive: DriveClient): Promise<void> {
  try {
    await drive.about.get({ fields: 'user' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const errStr = String(err)

    if (errStr.includes('disabled') || errStr.includes('not been used') || errStr.includes('Access Not Configured')) {
      throw new Error(
        'The Google Drive API is not enabled in your Google Cloud Console project. ' +
        'Go to console.cloud.google.com → APIs & Services → Enable the "Google Drive API".'
      )
    }

    if (errStr.includes('insufficient') || errStr.includes('permission')) {
      throw new Error(
        'Drive permission denied. The Drive API may not be enabled, or the required Drive scope was not granted. ' +
        'Try disconnecting and reconnecting your Google account in Settings. ' +
        'Also verify the Google Drive API is enabled in your Cloud Console project.'
      )
    }

    throw new Error(`Drive API check failed: ${message}`)
  }
}

async function findOrCreateFolder(
  drive: DriveClient,
  name: string,
  parentId?: string
): Promise<string> {
  // Search for existing folder
  let query = `name = '${name}' and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false`
  if (parentId) {
    query += ` and '${parentId}' in parents`
  }

  console.log(`[Drive] Searching for folder "${name}"...`)

  const res = await drive.files.list({
    q: query,
    fields: 'files(id)',
    spaces: 'drive',
    pageSize: 1
  })

  if (res.data.files && res.data.files.length > 0) {
    console.log(`[Drive] Found existing folder "${name}": ${res.data.files[0].id}`)
    return res.data.files[0].id!
  }

  // Create folder
  console.log(`[Drive] Creating folder "${name}"...`)
  const createRes = await drive.files.create({
    requestBody: {
      name,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      ...(parentId ? { parents: [parentId] } : {})
    },
    fields: 'id'
  })

  console.log(`[Drive] Created folder "${name}": ${createRes.data.id}`)
  return createRes.data.id!
}

async function ensureAppFolders(drive: DriveClient): Promise<{
  transcripts: string
  summaries: string
}> {
  if (transcriptsFolderId && summariesFolderId) {
    return { transcripts: transcriptsFolderId, summaries: summariesFolderId }
  }

  appFolderId = await findOrCreateFolder(drive, 'Cyggie')
  transcriptsFolderId = await findOrCreateFolder(drive, 'transcripts', appFolderId)
  summariesFolderId = await findOrCreateFolder(drive, 'summaries', appFolderId)

  return { transcripts: transcriptsFolderId, summaries: summariesFolderId }
}

async function uploadFileToDrive(
  drive: DriveClient,
  localPath: string,
  filename: string,
  parentFolderId: string
): Promise<{ fileId: string; webViewLink: string }> {
  const content = readFileSync(localPath, 'utf-8')

  console.log(`[Drive] Uploading "${filename}" to folder ${parentFolderId}...`)

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentFolderId]
    },
    media: {
      mimeType: 'text/markdown',
      body: Readable.from(content)
    },
    fields: 'id, webViewLink'
  })

  const fileId = res.data.id!
  let webViewLink = res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`
  console.log(`[Drive] File created: ${fileId}`)

  // Make shareable: anyone with link can read
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' }
    })
    console.log('[Drive] Set public sharing on file')

    // Re-fetch webViewLink after permission change
    const fileRes = await drive.files.get({
      fileId,
      fields: 'webViewLink'
    })
    if (fileRes.data.webViewLink) {
      webViewLink = fileRes.data.webViewLink
    }
  } catch (shareErr) {
    // Sharing failed — file is uploaded but only accessible to the owner.
    // This can happen with some Google Workspace restrictions.
    console.warn('[Drive] Could not set public sharing (file still uploaded):', shareErr)
  }

  return { fileId, webViewLink }
}

export async function uploadTranscript(
  localPath: string
): Promise<{ driveId: string; url: string }> {
  const drive = getDriveClient()
  if (!drive) throw new Error('Drive client not available')

  await verifyDriveAccess(drive)
  const folders = await ensureAppFolders(drive)
  const filename = basename(localPath)
  const result = await uploadFileToDrive(drive, localPath, filename, folders.transcripts)

  return { driveId: result.fileId, url: result.webViewLink }
}

export async function uploadSummary(
  localPath: string
): Promise<{ driveId: string; url: string }> {
  const drive = getDriveClient()
  if (!drive) throw new Error('Drive client not available')

  await verifyDriveAccess(drive)
  const folders = await ensureAppFolders(drive)
  const filename = basename(localPath)
  const result = await uploadFileToDrive(drive, localPath, filename, folders.summaries)

  return { driveId: result.fileId, url: result.webViewLink }
}

export async function getShareableLinkById(driveFileId: string): Promise<DriveShareResponse> {
  if (!isCalendarConnected()) {
    return {
      success: false,
      error: 'not_connected',
      message: 'Connect your Google account in Settings to share files via Drive.'
    }
  }

  if (!hasDriveScope()) {
    return {
      success: false,
      error: 'no_drive_scope',
      message:
        'Drive access not granted. Please grant Drive access in Settings to enable link sharing.'
    }
  }

  const drive = getDriveClient()
  if (!drive) {
    return {
      success: false,
      error: 'not_connected',
      message: 'Google account not configured.'
    }
  }

  try {
    const file = await drive.files.get({
      fileId: driveFileId,
      fields: 'webViewLink'
    })

    return { success: true, url: file.data.webViewLink! }
  } catch (err) {
    console.error('[Drive] Failed to get shareable link:', err)
    return {
      success: false,
      error: 'share_failed',
      message: `Failed to get shareable link: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export async function renameFile(driveFileId: string, newName: string): Promise<void> {
  const drive = getDriveClient()
  if (!drive) return

  await drive.files.update({
    fileId: driveFileId,
    requestBody: { name: newName }
  })
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function normalizeLookupValue(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '')
}

function extractDriveFolderId(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const directId = trimmed.match(/^[A-Za-z0-9_-]{10,}$/)
  if (directId) return directId[0]

  try {
    const parsed = new URL(trimmed)
    const folderMatch = parsed.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,})/)
    if (folderMatch?.[1]) return folderMatch[1]

    const idParam = parsed.searchParams.get('id')
    if (idParam && /^[A-Za-z0-9_-]{10,}$/.test(idParam)) {
      return idParam
    }
  } catch {
    return null
  }

  return null
}

function companyLookupKeys(companyName: string, primaryDomain?: string | null): string[] {
  const keys = new Set<string>()
  const normalizedName = normalizeLookupValue(companyName)
  if (normalizedName) keys.add(normalizedName)

  const normalizedDomain = normalizeLookupValue(primaryDomain)
  if (normalizedDomain) {
    keys.add(normalizedDomain)

    const domainBase = normalizeLookupValue((primaryDomain || '').split('.')[0] || '')
    if (domainBase) keys.add(domainBase)
  }

  return Array.from(keys)
}

function companyLookupTerms(companyName: string, primaryDomain?: string | null): string[] {
  const terms = new Set<string>()
  const trimmedName = companyName.trim()
  if (trimmedName) terms.add(trimmedName)

  const nameParts = trimmedName.split(/[^A-Za-z0-9]+/).map((part) => part.trim()).filter(Boolean)
  for (const part of nameParts) {
    if (part.length >= 4) terms.add(part)
  }

  const domain = (primaryDomain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]

  if (domain) {
    terms.add(domain)
    const base = domain.split('.')[0] || ''
    if (base.length >= 4) terms.add(base)
  }

  return Array.from(terms).slice(0, 8)
}

function hasFuzzyKeyOverlap(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (!a || !b) return false
  if (a === b) return true
  if (a.length < 5 || b.length < 5) return false
  return a.includes(b) || b.includes(a)
}

async function listAllDriveFiles(
  drive: DriveClient,
  query: string,
  fields: string,
  orderBy?: string,
  maxResults?: number
): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = []
  let pageToken: string | undefined

  do {
    const remaining = maxResults ? Math.max(maxResults - files.length, 0) : 200
    if (maxResults && remaining === 0) break

    const res = await drive.files.list({
      q: query,
      fields,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: maxResults ? Math.min(200, remaining) : 200,
      pageToken,
      orderBy
    })
    if (res.data.files && res.data.files.length > 0) {
      files.push(...res.data.files)
    }
    if (maxResults && files.length >= maxResults) {
      return files.slice(0, maxResults)
    }
    pageToken = res.data.nextPageToken || undefined
  } while (pageToken)

  return files
}

function chooseCompanyFolders(
  candidateFolders: drive_v3.Schema$File[],
  lookupKeys: string[]
): drive_v3.Schema$File[] {
  if (lookupKeys.length === 0) return []

  const normalizedKeys = lookupKeys.filter(Boolean)
  if (normalizedKeys.length === 0) return []

  const withNormalized = candidateFolders
    .filter((folder) => folder.id && folder.name)
    .map((folder) => ({
      folder,
      normalized: normalizeLookupValue(folder.name || '')
    }))
    .filter((entry) => entry.normalized.length > 0)

  const exactMatches = withNormalized
    .filter((entry) => normalizedKeys.includes(entry.normalized))
    .map((entry) => entry.folder)
  if (exactMatches.length > 0) return exactMatches

  const fuzzyMatches = withNormalized
    .filter((entry) =>
      normalizedKeys.some((key) => hasFuzzyKeyOverlap(entry.normalized, key))
    )
    .map((entry) => entry.folder)
  return fuzzyMatches
}

async function getFolderById(
  drive: DriveClient,
  folderId: string
): Promise<drive_v3.Schema$File | null> {
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType,trashed',
      supportsAllDrives: true
    })
    const folder = res.data
    if (!folder.id || !folder.name) return null
    if (folder.mimeType !== DRIVE_FOLDER_MIME_TYPE || folder.trashed) return null
    return folder
  } catch {
    return null
  }
}

function buildNameClause(
  terms: string[],
  operator: '=' | 'contains'
): string | null {
  const cleanedTerms = terms
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8)
  if (cleanedTerms.length === 0) return null

  return cleanedTerms
    .map((term) => `name ${operator} '${escapeDriveQueryLiteral(term)}'`)
    .join(' or ')
}

async function getFolderParents(
  drive: DriveClient,
  folderId: string,
  parentCache: Map<string, string[]>
): Promise<string[]> {
  const cached = parentCache.get(folderId)
  if (cached) return cached

  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id,parents',
      supportsAllDrives: true
    })
    const parents = Array.isArray(res.data.parents)
      ? res.data.parents.filter((parent): parent is string => Boolean(parent))
      : []
    parentCache.set(folderId, parents)
    return parents
  } catch {
    parentCache.set(folderId, [])
    return []
  }
}

async function isFolderWithinRoot(
  drive: DriveClient,
  folderId: string,
  rootFolderId: string,
  parentCache: Map<string, string[]>
): Promise<boolean> {
  if (folderId === rootFolderId) return true

  const queue: string[] = [folderId]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const currentId = queue.shift()
    if (!currentId || visited.has(currentId)) continue
    visited.add(currentId)

    if (currentId === rootFolderId) return true

    const parents = await getFolderParents(drive, currentId, parentCache)
    for (const parentId of parents) {
      if (parentId === rootFolderId) return true
      if (!visited.has(parentId)) queue.push(parentId)
    }
  }

  return false
}

async function filterFoldersWithinRoot(
  drive: DriveClient,
  rootFolderId: string,
  folders: drive_v3.Schema$File[]
): Promise<drive_v3.Schema$File[]> {
  const parentCache = new Map<string, string[]>()

  for (const folder of folders) {
    if (!folder.id) continue
    const parents = Array.isArray(folder.parents)
      ? folder.parents.filter((parent): parent is string => Boolean(parent))
      : []
    if (parents.length > 0) {
      parentCache.set(folder.id, parents)
    }
  }

  const filtered: drive_v3.Schema$File[] = []
  for (const folder of folders) {
    if (!folder.id) continue
    if (await isFolderWithinRoot(drive, folder.id, rootFolderId, parentCache)) {
      filtered.push(folder)
    }
  }
  return filtered
}

async function findCompanyFoldersByNameHints(
  drive: DriveClient,
  rootFolderId: string,
  lookupKeys: string[],
  lookupTerms: string[]
): Promise<drive_v3.Schema$File[]> {
  const exactClause = buildNameClause(lookupTerms, '=')
  if (exactClause) {
    const directExactQuery = `'${escapeDriveQueryLiteral(rootFolderId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false and (${exactClause})`
    const directExact = await listAllDriveFiles(
      drive,
      directExactQuery,
      'nextPageToken, files(id,name,mimeType,parents)'
    )
    const directExactMatches = chooseCompanyFolders(directExact, lookupKeys)
    if (directExactMatches.length > 0) return directExactMatches

    const globalExactQuery = `mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false and (${exactClause})`
    const globalExact = await listAllDriveFiles(
      drive,
      globalExactQuery,
      'nextPageToken, files(id,name,mimeType,parents)',
      undefined,
      200
    )
    const globalExactWithinRoot = await filterFoldersWithinRoot(drive, rootFolderId, globalExact)
    const globalExactMatches = chooseCompanyFolders(globalExactWithinRoot, lookupKeys)
    if (globalExactMatches.length > 0) return globalExactMatches
  }

  const containsTerms = lookupTerms.filter(
    (term) => normalizeLookupValue(term).length >= 5
  )
  const containsClause = buildNameClause(containsTerms, 'contains')
  if (!containsClause) return []

  const directContainsQuery = `'${escapeDriveQueryLiteral(rootFolderId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false and (${containsClause})`
  const directContains = await listAllDriveFiles(
    drive,
    directContainsQuery,
    'nextPageToken, files(id,name,mimeType,parents)',
    'name_natural',
    200
  )
  const directContainsMatches = chooseCompanyFolders(directContains, lookupKeys)
  if (directContainsMatches.length > 0) return directContainsMatches

  const globalContainsQuery = `mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false and (${containsClause})`
  const globalContains = await listAllDriveFiles(
    drive,
    globalContainsQuery,
    'nextPageToken, files(id,name,mimeType,parents)',
    undefined,
    300
  )
  const globalContainsWithinRoot = await filterFoldersWithinRoot(drive, rootFolderId, globalContains)
  return chooseCompanyFolders(globalContainsWithinRoot, lookupKeys)
}

async function listChildFolders(
  drive: DriveClient,
  parentFolderId: string
): Promise<drive_v3.Schema$File[]> {
  const query = `'${escapeDriveQueryLiteral(parentFolderId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false`
  return listAllDriveFiles(
    drive,
    query,
    'nextPageToken, files(id,name,mimeType)',
    'name_natural'
  )
}

export async function listDriveFolders(parentId = 'root'): Promise<DriveFolderRef[]> {
  const drive = getDriveFilesClient()
  if (!drive) return []

  await verifyDriveAccess(drive)

  const query = `'${escapeDriveQueryLiteral(parentId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false`
  const folders = await listAllDriveFiles(
    drive,
    query,
    'nextPageToken, files(id,name)',
    'name_natural'
  )

  return folders
    .filter((folder) => folder.id && folder.name)
    .map((folder) => ({
      id: folder.id as string,
      name: folder.name as string
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function listDescendantFolders(
  drive: DriveClient,
  rootFolderId: string
): Promise<drive_v3.Schema$File[]> {
  const queue: string[] = [rootFolderId]
  const visitedFolderIds = new Set<string>([rootFolderId])
  const descendantFolders: drive_v3.Schema$File[] = []

  while (queue.length > 0) {
    const currentFolderId = queue.shift()
    if (!currentFolderId) continue

    const childFolders = await listChildFolders(drive, currentFolderId)

    for (const childFolder of childFolders) {
      const childId = childFolder.id || ''
      if (!childId) continue

      descendantFolders.push(childFolder)

      if (!visitedFolderIds.has(childId)) {
        visitedFolderIds.add(childId)
        queue.push(childId)
      }
    }
  }

  return descendantFolders
}

async function listFilesRecursivelyInFolder(
  drive: DriveClient,
  folderId: string,
  folderName: string
): Promise<CompanyDriveFileRef[]> {
  const queue: Array<{ id: string; name: string }> = [{ id: folderId, name: folderName }]
  const visitedFolders = new Set<string>()
  const files: CompanyDriveFileRef[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    if (visitedFolders.has(current.id)) continue
    visitedFolders.add(current.id)

    const query = `'${escapeDriveQueryLiteral(current.id)}' in parents and trashed = false`
    const children = await listAllDriveFiles(
      drive,
      query,
      'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink,size)'
    )

    for (const child of children) {
      const childId = child.id || ''
      if (!childId) continue

      if (child.mimeType === DRIVE_FOLDER_MIME_TYPE) {
        queue.push({
          id: childId,
          name: child.name || current.name
        })
        continue
      }

      const parsedSize =
        child.size && /^\d+$/.test(child.size) ? Number(child.size) : null
      files.push({
        id: childId,
        name: child.name || 'Untitled',
        mimeType: child.mimeType || 'application/octet-stream',
        modifiedAt: child.modifiedTime || null,
        webViewLink: child.webViewLink || `https://drive.google.com/open?id=${childId}`,
        sizeBytes: parsedSize,
        parentFolderName: current.name || null
      })
    }
  }

  return files
}

function dedupeAndSortCompanyFiles(files: CompanyDriveFileRef[]): CompanyDriveFileRef[] {
  const deduped = new Map<string, CompanyDriveFileRef>()
  for (const file of files) {
    deduped.set(file.id, file)
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const at = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0
    const bt = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0
    if (bt !== at) return bt - at
    return a.name.localeCompare(b.name)
  })
}

export async function listFilesInDriveFolder(
  folderRef: string
): Promise<CompanyDriveFileRef[] | null> {
  const folderId = extractDriveFolderId(folderRef)
  if (!folderId) return null

  const drive = getDriveFilesClient()
  if (!drive) return null

  await verifyDriveAccess(drive)

  const folder = await getFolderById(drive, folderId)
  if (!folder?.id) return null

  const files = await listFilesRecursivelyInFolder(
    drive,
    folder.id,
    folder.name || 'Folder'
  )
  return dedupeAndSortCompanyFiles(files)
}

export async function listCompanyFilesByDriveFolder(
  rootFolderRef: string,
  companyName: string,
  primaryDomain?: string | null
): Promise<CompanyDriveLookupResult> {
  const rootFolderId = extractDriveFolderId(rootFolderRef)
  if (!rootFolderId) return { files: [], matchedFolderRef: null }

  const lookupKeys = companyLookupKeys(companyName, primaryDomain)
  if (lookupKeys.length === 0) return { files: [], matchedFolderRef: null }
  const lookupTerms = companyLookupTerms(companyName, primaryDomain)
  console.log(`[Company Files][Drive] Lookup keys for "${companyName}": ${JSON.stringify(lookupKeys)}`)
  console.log(`[Company Files][Drive] Lookup terms for "${companyName}": ${JSON.stringify(lookupTerms)}`)

  const drive = getDriveFilesClient()
  if (!drive) return { files: [], matchedFolderRef: null }

  await verifyDriveAccess(drive)

  let matchingFolders: drive_v3.Schema$File[] = []
  const rootFolder = await getFolderById(drive, rootFolderId)
  if (rootFolder) {
    matchingFolders = chooseCompanyFolders([rootFolder], lookupKeys)
  }

  if (matchingFolders.length === 0) {
    matchingFolders = await findCompanyFoldersByNameHints(
      drive,
      rootFolderId,
      lookupKeys,
      lookupTerms
    )
  }

  if (matchingFolders.length === 0) {
    const directChildFolders = await listChildFolders(drive, rootFolderId)
    matchingFolders = chooseCompanyFolders(directChildFolders, lookupKeys)
  }

  if (matchingFolders.length === 0) {
    const descendantFolders = await listDescendantFolders(drive, rootFolderId)
    matchingFolders = chooseCompanyFolders(descendantFolders, lookupKeys)
  }

  if (matchingFolders.length === 0) {
    console.log('[Company Files][Drive] No matching folders found')
    return { files: [], matchedFolderRef: null }
  }

  console.log(`[Company Files][Drive] Matched folders: ${matchingFolders.map((folder) => folder.name || '').filter(Boolean).join(', ')}`)

  const collectedFiles: CompanyDriveFileRef[] = []
  let matchedFolderWithFilesRef: string | null = null
  for (const folder of matchingFolders) {
    if (!folder.id || !folder.name) continue
    const filesInFolder = await listFilesRecursivelyInFolder(drive, folder.id, folder.name)
    if (filesInFolder.length > 0 && !matchedFolderWithFilesRef) {
      matchedFolderWithFilesRef = folder.id
    }
    collectedFiles.push(...filesInFolder)
  }

  const fallbackFolderRef =
    matchingFolders.find((folder) => folder.id)?.id || null
  return {
    files: dedupeAndSortCompanyFiles(collectedFiles),
    matchedFolderRef: matchedFolderWithFilesRef || fallbackFolderRef
  }
}
