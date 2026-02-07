import { readFileSync } from 'fs'
import { basename } from 'path'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { getOAuth2Client, isCalendarConnected, hasDriveScope } from '../calendar/google-auth'
import type { DriveShareResponse } from '../../shared/types/drive'

type DriveClient = ReturnType<typeof google.drive>

// In-memory cache for folder IDs (cleared on app restart)
let appFolderId: string | null = null
let transcriptsFolderId: string | null = null
let summariesFolderId: string | null = null

function getDriveClient(): DriveClient | null {
  const auth = getOAuth2Client()
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
        'Drive permission denied. The Drive API may not be enabled, or the drive.file scope was not granted. ' +
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
  let query = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
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
      mimeType: 'application/vnd.google-apps.folder',
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

  appFolderId = await findOrCreateFolder(drive, 'GORP')
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
