import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getCredential } from '../security/credentials'
import * as meetingRepo from '../database/repositories/meeting.repo'
import * as notesRepo from '../database/repositories/notes.repo'
import { hydrateCompanionNote } from './note-hydration'
import { readTranscript, readSummary } from '../storage/file-manager'
import { recoverSummaryFromCompanionNote } from '../services/meeting-summary-recovery'
import type { WebShareResponse } from '../../shared/types/web-share'
import { WEB_SHARE_API_URL, WEB_SHARE_API_SECRET } from '../config/web-share.config'
import { getSetting } from '../database/repositories/settings.repo'
import { listMeetingCompanies } from '../database/repositories/org-company.repo'

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

      let summary = meeting.summaryPath ? readSummary(meeting.summaryPath) : null
      if (!summary && meeting.status === 'summarized') {
        summary = recoverSummaryFromCompanionNote(meeting)
      }

      // Fetch linked companies with their favicon URLs
      const linkedCompanies = listMeetingCompanies(meeting.id)
      const companies = await Promise.all(
        linkedCompanies.map(async (c) => {
          let logoUrl: string | null = null
          if (c.primaryDomain) {
            try {
              const faviconUrl = `https://www.google.com/s2/favicons?sz=128&domain=${c.primaryDomain}`
              const res = await fetch(faviconUrl, { signal: AbortSignal.timeout(3000) })
              if (res.ok) {
                const buffer = Buffer.from(await res.arrayBuffer())
                const mime = res.headers.get('content-type') ?? 'image/png'
                logoUrl = `data:${mime};base64,${buffer.toString('base64')}`
              }
            } catch {
              // favicon fetch failed — show company name without logo
            }
          }
          return { name: c.canonicalName, logoUrl }
        })
      )

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
            logoUrl: getSetting('brandingLogoDataUrl') || null,
            firmName: getSetting('brandingFirmName') || null,
            brandColor: getSetting('brandingPrimaryColor') || null,
            companies,
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

  ipcMain.handle(
    IPC_CHANNELS.WEB_SHARE_CREATE_NOTE,
    async (_event, noteId: string): Promise<WebShareResponse> => {
      const note = notesRepo.getNote(noteId)
      if (!note) {
        return { success: false, error: 'upload_failed', message: 'Note not found.' }
      }

      const claudeApiKey = getCredential('claudeApiKey')
      if (!claudeApiKey) {
        return {
          success: false,
          error: 'no_api_key',
          message: 'Claude API key not configured. Set it in Settings.',
        }
      }

      try {
        const hydrated = hydrateCompanionNote(note)

        if (!hydrated.content?.trim()) {
          return {
            success: false,
            error: 'upload_failed',
            message: 'Cannot share an empty note.',
          }
        }

        const response = await fetch(`${WEB_SHARE_API_URL}/api/note-share`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${WEB_SHARE_API_SECRET}`,
          },
          body: JSON.stringify({
            title: hydrated.title || 'Untitled',
            contentMarkdown: hydrated.content,
            claudeApiKey,
            logoUrl: getSetting('brandingLogoDataUrl') || null,
            firmName: getSetting('brandingFirmName') || null,
            brandColor: getSetting('brandingPrimaryColor') || null,
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
