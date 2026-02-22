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

async function listAllDriveFiles(
  drive: DriveClient,
  query: string,
  fields: string,
  orderBy?: string
): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = []
  let pageToken: string | undefined

  do {
    const res = await drive.files.list({
      q: query,
      fields,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 200,
      pageToken,
      orderBy
    })
    if (res.data.files && res.data.files.length > 0) {
      files.push(...res.data.files)
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
      normalizedKeys.some((key) => key.length >= 5 && entry.normalized.includes(key))
    )
    .map((entry) => entry.folder)
  return fuzzyMatches
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

    const query = `'${escapeDriveQueryLiteral(currentFolderId)}' in parents and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and trashed = false`
    const childFolders = await listAllDriveFiles(
      drive,
      query,
      'nextPageToken, files(id,name,mimeType)',
      'name_natural'
    )

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

export async function listCompanyFilesByDriveFolder(
  rootFolderRef: string,
  companyName: string,
  primaryDomain?: string | null
): Promise<CompanyDriveFileRef[]> {
  const rootFolderId = extractDriveFolderId(rootFolderRef)
  if (!rootFolderId) return []

  const lookupKeys = companyLookupKeys(companyName, primaryDomain)
  if (lookupKeys.length === 0) return []

  const drive = getDriveFilesClient()
  if (!drive) return []

  await verifyDriveAccess(drive)

  const descendantFolders = await listDescendantFolders(drive, rootFolderId)

  const matchingFolders = chooseCompanyFolders(descendantFolders, lookupKeys)
  if (matchingFolders.length === 0) return []

  const collectedFiles: CompanyDriveFileRef[] = []
  for (const folder of matchingFolders) {
    if (!folder.id || !folder.name) continue
    const filesInFolder = await listFilesRecursivelyInFolder(drive, folder.id, folder.name)
    collectedFiles.push(...filesInFolder)
  }

  const deduped = new Map<string, CompanyDriveFileRef>()
  for (const file of collectedFiles) {
    deduped.set(file.id, file)
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const at = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0
    const bt = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0
    if (bt !== at) return bt - at
    return a.name.localeCompare(b.name)
  })
}
