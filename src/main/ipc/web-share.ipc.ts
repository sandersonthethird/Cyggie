import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getCredential } from '../security/credentials'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { readTranscript, readSummary } from '../storage/file-manager'
import type { WebShareResponse } from '../../shared/types/web-share'

const WEB_SHARE_API_URL = 'https://cyggie.vercel.app'
const WEB_SHARE_API_SECRET = import.meta.env.MAIN_VITE_SHARE_SECRET || ''

export function registerWebShareHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.WEB_SHARE_CREATE,
    async (_event, meetingId: string): Promise<WebShareResponse> => {
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) {
        return { success: false, error: 'upload_failed', message: 'Meeting not found.' }
      }

      if (!meeting.transcriptPath) {
        return {
          success: false,
          error: 'no_transcript',
          message: 'No transcript available to share.',
        }
      }

      const claudeApiKey = getCredential('claudeApiKey')
      if (!claudeApiKey) {
        return {
          success: false,
          error: 'no_api_key',
          message: 'Claude API key not configured. Set it in Settings.',
        }
      }

      const transcript = readTranscript(meeting.transcriptPath)
      if (!transcript) {
        return {
          success: false,
          error: 'no_transcript',
          message: 'Could not read transcript file.',
        }
      }

      const summary = meeting.summaryPath ? readSummary(meeting.summaryPath) : null

      try {
        const response = await fetch(`${WEB_SHARE_API_URL}/api/share`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${WEB_SHARE_API_SECRET}`,
          },
          body: JSON.stringify({
            title: meeting.title,
            date: meeting.date,
            durationSeconds: meeting.durationSeconds,
            speakerMap: meeting.speakerMap,
            attendees: meeting.attendees,
            summary,
            transcript,
            notes: meeting.notes,
            claudeApiKey,
          }),
        })

        if (!response.ok) {
          const errText = await response.text()
          return {
            success: false,
            error: 'upload_failed',
            message: `Server error: ${errText}`,
          }
        }

        const result = await response.json()
        return { success: true, url: result.url, token: result.token }
      } catch (err) {
        return {
          success: false,
          error: 'network_error',
          message: `Failed to create share: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  )
}
