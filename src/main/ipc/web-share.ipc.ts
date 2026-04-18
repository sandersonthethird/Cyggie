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
import { getDatabase } from '../database/connection'

/**
 * Builds a speakerMap with contact display names resolved.
 * Two-pass strategy:
 *   1. meeting_speaker_contact_links → full_name (speaker index based)
 *   2. For remaining email-valued entries: contacts.email → full_name
 *
 * raw speakerMap:    { "0": "alice@example.com", "1": "bob@example.com" }
 * resolved:          { "0": "Alice Smith",        "1": "Bob Jones"       }
 */
function resolvedSpeakerMap(meetingId: string, rawMap: Record<string, string>): Record<string, string> {
  const db = getDatabase()
  const resolved = { ...rawMap }

  // Pass 1: speaker-contact links (explicit user assignments)
  const linked = db
    .prepare(`
      SELECT l.speaker_index, c.full_name
      FROM meeting_speaker_contact_links l
      JOIN contacts c ON c.id = l.contact_id
      WHERE l.meeting_id = ?
    `)
    .all(meetingId) as { speaker_index: number; full_name: string }[]
  for (const row of linked) {
    if (row.full_name) resolved[String(row.speaker_index)] = row.full_name
  }

  // Pass 2: email-valued entries not yet resolved — look up by email
  const emails = Object.entries(resolved)
    .filter(([, v]) => v.includes('@'))
    .map(([, v]) => v)
  if (emails.length > 0) {
    const placeholders = emails.map(() => '?').join(', ')
    const byEmail = db
      .prepare(`SELECT email, full_name FROM contacts WHERE email IN (${placeholders})`)
      .all(...emails) as { email: string; full_name: string }[]
    const nameByEmail = Object.fromEntries(byEmail.map((r) => [r.email, r.full_name]))
    for (const [idx, val] of Object.entries(resolved)) {
      if (val.includes('@') && nameByEmail[val]) resolved[idx] = nameByEmail[val]
    }
  }

  return resolved
}

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

      const claudeApiKey = getCredential('webShareApiKey') || getCredential('claudeApiKey')
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
            speakerMap: resolvedSpeakerMap(meetingId, meeting.speakerMap as Record<string, string>),
            attendees: meeting.attendees,
            summary,
            transcript,
            notes: meeting.notes,
            claudeApiKey,
            claudeModel: getSetting('webShareModel') || 'claude-sonnet-4-5-20250929',
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

        const result = await response.json() as { url: string; token: string }
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

      const claudeApiKey = getCredential('webShareApiKey') || getCredential('claudeApiKey')
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
            claudeModel: getSetting('webShareModel') || 'claude-sonnet-4-5-20250929',
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

        const result = await response.json() as { url: string; token: string }
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
