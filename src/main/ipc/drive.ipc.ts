import { ipcMain } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  getShareableLinkById,
  listDriveFolders,
  uploadSummary,
  uploadTranscript
} from '../drive/google-drive'
import {
  authorizeDriveFiles,
  hasDriveFilesScope,
  hasDriveScope,
  isCalendarConnected
} from '../calendar/google-auth'
import { getSummariesDir, getTranscriptsDir } from '../storage/paths'
import * as meetingRepo from '../database/repositories/meeting.repo'

export function registerDriveHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.DRIVE_GET_SHARE_LINK,
    async (_event, meetingId: string) => {
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) {
        return { success: false, error: 'share_failed', message: 'Meeting not found.' }
      }

      // If we already have a Drive ID, return its link
      const existingDriveId = meeting.summaryDriveId || meeting.transcriptDriveId
      if (existingDriveId) {
        return getShareableLinkById(existingDriveId)
      }

      // No Drive ID yet — try uploading on-demand
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
          message: 'Drive access not granted. Please grant Drive access in Settings.'
        }
      }

      // Prefer summary, fall back to transcript
      try {
        if (meeting.summaryPath) {
          const fullPath = join(getSummariesDir(), meeting.summaryPath)
          const { driveId, url } = await uploadSummary(fullPath)
          meetingRepo.updateMeeting(meetingId, { summaryDriveId: driveId })
          console.log('[Drive] Summary uploaded on-demand:', driveId)
          return { success: true, url }
        }

        if (meeting.transcriptPath) {
          const fullPath = join(getTranscriptsDir(), meeting.transcriptPath)
          const { driveId, url } = await uploadTranscript(fullPath)
          meetingRepo.updateMeeting(meetingId, { transcriptDriveId: driveId })
          console.log('[Drive] Transcript uploaded on-demand:', driveId)
          return { success: true, url }
        }

        return {
          success: false,
          error: 'not_synced',
          message: 'No summary or transcript file exists for this meeting.'
        }
      } catch (err) {
        console.error('[Drive] On-demand upload failed:', err)
        return {
          success: false,
          error: 'share_failed',
          message: `Upload failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.DRIVE_HAS_SCOPE, () => {
    return hasDriveScope()
  })

  ipcMain.handle(IPC_CHANNELS.DRIVE_HAS_FILES_SCOPE, () => {
    return hasDriveFilesScope()
  })

  ipcMain.handle(IPC_CHANNELS.DRIVE_LIST_FOLDERS, async (_event, parentId?: string) => {
    if (!hasDriveFilesScope()) return []
    return listDriveFolders((parentId || 'root').trim() || 'root')
  })

  ipcMain.handle(IPC_CHANNELS.DRIVE_AUTHORIZE_FILES, async () => {
    await authorizeDriveFiles()
    return { connected: true }
  })
}
