import { ipcMain, shell, dialog } from 'electron'
import { readFileSync } from 'fs'
import { extname } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as meetingRepo from '../database/repositories/meeting.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import { readTranscript, readSummary, updateTranscriptContent, updateSummaryContent, deleteTranscript, deleteSummary, deleteRecording, renameTranscript, renameSummary, renameRecording } from '../storage/file-manager'
import { removeFromIndex } from '../database/repositories/search.repo'
import { getStoragePath, setStoragePath } from '../storage/paths'
import { renameFile as renameDriveFile } from '../drive/google-drive'
import { extractCompaniesFromEmails, extractCompaniesFromAttendees, extractDomainFromEmail } from '../utils/company-extractor'
import { enrichCompaniesForMeeting, getCompanySuggestionsForMeeting } from '../services/company-enrichment'
import { syncContactsFromAttendees } from '../database/repositories/contact.repo'
import { linkMeetingCompany, getCompany, findCompanyIdByNameOrDomain, unlinkMeetingCompany, getOrCreateCompanyByName } from '../database/repositories/org-company.repo'
import { upsert as upsertCompanyCache, getByDomain as getCompanyCacheByDomain } from '../database/repositories/company.repo'
import { getDatabase } from '../database/connection'
import type { ChatMessage, MeetingListFilter } from '../../shared/types/meeting'
import { getCurrentUserId, getCurrentUserProfile } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

// Pure helpers — exported for unit testing
export function mergeSpeakerTag(
  speakerMap: Record<number, string>,
  contactMap: Record<number, string>,
  index: number,
  contactId: string,
  contactName: string
): { speakerMap: Record<number, string>; contactMap: Record<number, string> } {
  return {
    speakerMap: { ...speakerMap, [index]: contactName },
    contactMap: { ...contactMap, [index]: contactId }
  }
}

export function removeSpeakerTag(
  speakerMap: Record<number, string>,
  contactMap: Record<number, string>,
  index: number
): { speakerMap: Record<number, string>; contactMap: Record<number, string> } {
  const newContactMap = { ...contactMap }
  delete newContactMap[index]
  return {
    speakerMap: { ...speakerMap, [index]: `Speaker ${index}` },
    contactMap: newContactMap
  }
}

export function appendCompanyIfMissing(companies: string[] | null, canonicalName: string): string[] {
  const arr = companies ?? []
  return arr.includes(canonicalName) ? arr : [...arr, canonicalName]
}

function removeCompanyFromList(companies: string[] | null, canonicalName: string): string[] {
  if (!companies) return []
  return companies.filter((n) => n.toLowerCase() !== canonicalName.toLowerCase())
}

export function registerMeetingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MEETING_LIST, (_event, filter?: MeetingListFilter) => {
    return meetingRepo.listMeetings(filter)
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_GET, (_event, id: string) => {
    const meeting = meetingRepo.getMeeting(id)
    if (!meeting) return null

    const transcript = meeting.transcriptPath ? readTranscript(meeting.transcriptPath) : null
    const summary = meeting.summaryPath ? readSummary(meeting.summaryPath) : null

    const db = getDatabase()
    const linkedCompanies = db
      .prepare(`
        SELECT c.id, c.canonical_name AS name
        FROM meeting_company_links l
        JOIN org_companies c ON c.id = l.company_id
        WHERE l.meeting_id = ?
        ORDER BY c.canonical_name
      `)
      .all(id) as { id: string; name: string }[]

    return { meeting, transcript, summary, linkedCompanies }
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_UPDATE, (_event, id: string, data: Parameters<typeof meetingRepo.updateMeeting>[1]) => {
    const userId = getCurrentUserId()
    const updated = meetingRepo.updateMeeting(id, data, userId)
    if (updated && (data.attendees !== undefined || data.attendeeEmails !== undefined)) {
      try {
        syncContactsFromAttendees(updated.attendees, updated.attendeeEmails, userId)
      } catch (err) {
        console.error('[Contacts] Failed to sync from meeting update:', err)
      }
    }
    if (updated) {
      logAudit(userId, 'meeting', id, 'update', data)
    }
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_DELETE, (_event, id: string) => {
    const userId = getCurrentUserId()
    const meeting = meetingRepo.getMeeting(id)
    if (meeting) {
      if (meeting.transcriptPath) deleteTranscript(meeting.transcriptPath)
      if (meeting.summaryPath) deleteSummary(meeting.summaryPath)
      if (meeting.recordingPath) deleteRecording(meeting.recordingPath)
      removeFromIndex(id)
    }
    // Delete empty companion notes before the meeting is removed.
    // Notes with user-written content are preserved as standalone notes (ON DELETE SET NULL).
    const db = getDatabase()
    db.prepare("DELETE FROM notes WHERE source_meeting_id = ? AND TRIM(content) = ''").run(id)
    const deleted = meetingRepo.deleteMeeting(id)
    if (deleted) {
      logAudit(userId, 'meeting', id, 'delete', null)
    }
    return deleted
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_SPEAKERS,
    (_event, id: string, newSpeakerMap: Record<number, string>) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      const oldSpeakerMap = meeting.speakerMap

      // Update speaker map in DB
      meetingRepo.updateMeeting(id, { speakerMap: newSpeakerMap }, userId)

      // Rewrite transcript file with updated speaker names.
      // The file content may be out of sync with the DB speakerMap (e.g. from
      // a prior file collision), so we scan the file for actual names rather
      // than relying solely on the DB values.
      if (meeting.transcriptPath) {
        let content = readTranscript(meeting.transcriptPath)
        if (content) {
          // Collect all unique speaker names currently in the file
          const fileNames = new Set<string>()
          const headerPattern = /^\*\*(.+?)\*\* \[/gm
          let match
          while ((match = headerPattern.exec(content)) !== null) {
            fileNames.add(match[1])
          }

          // Build set of all new names for quick lookup
          const newNameValues = new Set(Object.values(newSpeakerMap))

          for (const [index, newName] of Object.entries(newSpeakerMap)) {
            const idx = Number(index)
            const dbName = oldSpeakerMap[idx]

            // Skip if DB name hasn't changed
            if (dbName === newName) continue

            // Try to find the actual name in the file for this index:
            // 1. The DB name (ideal case — DB and file are in sync)
            // 2. The default "Speaker N" name
            let fileOldName: string | undefined
            if (dbName && fileNames.has(dbName)) {
              fileOldName = dbName
            } else if (fileNames.has(`Speaker ${idx + 1}`)) {
              fileOldName = `Speaker ${idx + 1}`
            } else {
              // DB and file are out of sync — find the orphan name in the file
              // that isn't claimed by any entry in the new speaker map
              for (const fname of fileNames) {
                if (!newNameValues.has(fname)) {
                  fileOldName = fname
                  break
                }
              }
            }

            if (fileOldName && fileOldName !== newName) {
              const escaped = fileOldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const pattern = new RegExp(`^\\*\\*${escaped}\\*\\*`, 'gm')
              content = content.replace(pattern, `**${newName}**`)
              // Remove from fileNames so it won't be matched again
              fileNames.delete(fileOldName)
              fileNames.add(newName)
            }
          }

          updateTranscriptContent(meeting.transcriptPath, content)
        }
      }

      logAudit(userId, 'meeting', id, 'update', { speakerMap: newSpeakerMap })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_TITLE,
    (_event, id: string, newTitle: string) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      const trimmed = newTitle.trim()
      if (!trimmed || trimmed === meeting.title) return meeting

      const updates: Parameters<typeof meetingRepo.updateMeeting>[1] = { title: trimmed }

      // Promote scheduled notes so they aren't cleaned up as expired
      if (meeting.status === 'scheduled') {
        updates.status = 'transcribed'
      }

      if (meeting.transcriptPath) {
        updates.transcriptPath = renameTranscript(meeting.transcriptPath, id, trimmed, meeting.date, meeting.attendees)
      }
      if (meeting.summaryPath) {
        updates.summaryPath = renameSummary(meeting.summaryPath, id, trimmed, meeting.date, meeting.attendees)
      }
      if (meeting.recordingPath) {
        updates.recordingPath = renameRecording(meeting.recordingPath, id, trimmed, meeting.date, meeting.attendees)
      }

      meetingRepo.updateMeeting(id, updates, userId)

      // Rename Drive files if they exist (fire-and-forget)
      if (meeting.transcriptDriveId && updates.transcriptPath) {
        renameDriveFile(meeting.transcriptDriveId, updates.transcriptPath).catch((err) =>
          console.error('[Drive] Failed to rename transcript:', err)
        )
      }
      if (meeting.summaryDriveId && updates.summaryPath) {
        renameDriveFile(meeting.summaryDriveId, updates.summaryPath).catch((err) =>
          console.error('[Drive] Failed to rename summary:', err)
        )
      }

      logAudit(userId, 'meeting', id, 'update', { title: trimmed })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_NOTES,
    (_event, id: string, notes: string) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')
      const noteUpdates: Parameters<typeof meetingRepo.updateMeeting>[1] = { notes: notes || null }
      // Promote scheduled notes so they aren't cleaned up as expired
      if (meeting.status === 'scheduled' && notes?.trim()) {
        noteUpdates.status = 'transcribed'
      }
      meetingRepo.updateMeeting(id, noteUpdates, userId)
      logAudit(userId, 'meeting', id, 'update', { notes: Boolean(notes) })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_SUMMARY,
    (_event, id: string, summaryContent: string) => {
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')
      if (!meeting.summaryPath) throw new Error('Meeting has no summary file')
      updateSummaryContent(meeting.summaryPath, summaryContent)
      meetingRepo.updateMeeting(id, { summaryPath: meeting.summaryPath }, userId)
      logAudit(userId, 'meeting', id, 'update', { summaryEdited: true })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_CHAT,
    (_event, id: string, messages: ChatMessage[]) => {
      const userId = getCurrentUserId()
      meetingRepo.updateMeeting(id, { chatMessages: messages }, userId)
      logAudit(userId, 'meeting', id, 'update', { chatMessageCount: messages.length })
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE, () => {
    const userId = getCurrentUserId()
    const meeting = meetingRepo.createMeeting({
      title: `Note ${new Date().toLocaleDateString()}`,
      date: new Date().toISOString(),
      status: 'scheduled'
    }, userId)
    logAudit(userId, 'meeting', meeting.id, 'create', { source: 'manual-note' })
    return meeting
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_PREPARE,
    (_event, calendarEventId: string, title: string, date: string, platform?: string, meetingUrl?: string, attendees?: string[], attendeeEmails?: string[]) => {
      // Check if a meeting already exists for this calendar event
      const existing = meetingRepo.findMeetingByCalendarEventId(calendarEventId)
      if (existing) {
        const userId = getCurrentUserId()
        try {
          syncContactsFromAttendees(existing.attendees, existing.attendeeEmails, userId)
        } catch (err) {
          console.error('[Contacts] Failed to sync from existing prepared meeting:', err)
        }
        return existing
      }

      // Use heuristic names for immediate response
      const companies = attendeeEmails && attendeeEmails.length > 0
        ? extractCompaniesFromEmails(attendeeEmails)
        : extractCompaniesFromAttendees(attendees || [])

      // Create a new meeting with 'scheduled' status
      const userId = getCurrentUserId()
      const meeting = meetingRepo.createMeeting({
        title,
        date,
        calendarEventId,
        meetingPlatform: (platform as import('../../shared/constants/meeting-apps').MeetingPlatform) || null,
        meetingUrl: meetingUrl || null,
        attendees: attendees || null,
        attendeeEmails: attendeeEmails || null,
        companies: companies.length > 0 ? companies : null,
        status: 'scheduled'
      }, userId)
      logAudit(userId, 'meeting', meeting.id, 'create', {
        source: 'calendar-prepare',
        calendarEventId
      })

      try {
        syncContactsFromAttendees(meeting.attendees, meeting.attendeeEmails, userId)
      } catch (err) {
        console.error('[Contacts] Failed to sync from prepared meeting:', err)
      }

      // Fire off async enrichment to resolve true company names
      const emails = attendeeEmails || (attendees || []).filter((a) => a.includes('@'))
      if (emails.length > 0) {
        enrichCompaniesForMeeting(meeting.id, emails).catch((err) =>
          console.error('[Company Enrichment] Failed:', err)
        )
      }

      return meeting
    }
  )

  // Company enrichment: trigger enrichment for a specific meeting
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_ENRICH_MEETING,
    async (_event, meetingId: string) => {
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) return { success: false, error: 'not_found', message: 'Meeting not found' }

      const emails = meeting.attendeeEmails || (meeting.attendees || []).filter((a) => a.includes('@'))
      if (emails.length === 0) return { success: true }

      await enrichCompaniesForMeeting(meetingId, emails)
      return { success: true }
    }
  )

  // Company suggestions: get CompanySuggestion[] for a meeting
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_GET_SUGGESTIONS,
    (_event, meetingId: string) => {
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) return []
      const suggestions = getCompanySuggestionsForMeeting(meeting.attendeeEmails, meeting.companies)
      return suggestions.map((s) => {
        const id = findCompanyIdByNameOrDomain(s.name, s.domain) ?? undefined
        return id ? { ...s, id } : s
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_STORAGE_DIR, () => {
    shell.openPath(getStoragePath())
  })

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, async (_event, rawUrl: string) => {
    if (typeof rawUrl !== 'string') {
      throw new Error('URL must be a string')
    }
    const trimmed = rawUrl.trim()
    if (!trimmed) {
      throw new Error('URL is required')
    }
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are allowed')
    }
    // Inject authuser for Google Meet so the browser opens with the configured account
    if (parsed.hostname === 'meet.google.com') {
      try {
        const email = getCurrentUserProfile().email
        if (email) parsed.searchParams.set('authuser', email)
      } catch {
        // Non-fatal: open without authuser if profile unavailable
      }
    }
    return shell.openExternal(parsed.toString())
  })

  ipcMain.handle(IPC_CHANNELS.APP_OPEN_PATH, (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Path is required')
    }
    return shell.openPath(filePath.trim())
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_STORAGE_PATH, () => {
    return getStoragePath()
  })

  ipcMain.handle(IPC_CHANNELS.APP_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.APP_PICK_LOGO_FILE, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose logo image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const ext = extname(filePath).slice(1).toLowerCase()
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp'
    }
    const mime = mimeMap[ext] || 'image/png'
    const buf = readFileSync(filePath)
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle(IPC_CHANNELS.APP_CHANGE_STORAGE_DIR, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose storage directory',
      defaultPath: getStoragePath(),
      properties: ['openDirectory', 'createDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const newPath = result.filePaths[0]
    setStoragePath(newPath)
    settingsRepo.setSetting('storagePath', newPath)
    return newPath
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_TAG_SPEAKER_CONTACT,
    (
      _event,
      meetingId: string,
      speakerIndex: number,
      contactId: string | null,
      contactName: string | null
    ) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!Number.isInteger(speakerIndex) || speakerIndex < 0) throw new Error('speakerIndex must be a non-negative integer')
      const userId = getCurrentUserId()
      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      const db = getDatabase()

      if (contactId && contactName) {
        // LINK: rename speaker + insert join row
        const updatedSpeakerMap = { ...meeting.speakerMap, [speakerIndex]: contactName }
        const updated = meetingRepo.updateMeeting(meetingId, { speakerMap: updatedSpeakerMap }, userId)
        if (!updated) throw new Error('Failed to update meeting')

        db.prepare(
          'INSERT OR REPLACE INTO meeting_speaker_contact_links (meeting_id, speaker_index, contact_id) VALUES (?, ?, ?)'
        ).run(meetingId, speakerIndex, contactId)

        // Auto-tag companion note (first-link-wins, non-fatal)
        try {
          const companionNote = db
            .prepare('SELECT id, contact_id FROM notes WHERE source_meeting_id = ? LIMIT 1')
            .get(meetingId) as { id: string; contact_id: string | null } | undefined
          if (companionNote && !companionNote.contact_id) {
            db.prepare('UPDATE notes SET contact_id = ? WHERE id = ?').run(contactId, companionNote.id)
          }
        } catch (err) {
          console.warn('[MeetingDetail] Failed to auto-tag companion note:', err)
        }

        logAudit(userId, 'meeting', meetingId, 'tag_speaker_contact', { speakerIndex, contactId })
      } else {
        // UNLINK: reset speaker name + delete join row
        const defaultName = `Speaker ${speakerIndex}`
        const updatedSpeakerMap = { ...meeting.speakerMap, [speakerIndex]: defaultName }
        const updated = meetingRepo.updateMeeting(meetingId, { speakerMap: updatedSpeakerMap }, userId)
        if (!updated) throw new Error('Failed to update meeting')

        db.prepare(
          'DELETE FROM meeting_speaker_contact_links WHERE meeting_id = ? AND speaker_index = ?'
        ).run(meetingId, speakerIndex)

        logAudit(userId, 'meeting', meetingId, 'untag_speaker_contact', { speakerIndex })
      }

      return meetingRepo.getMeeting(meetingId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_LINK_EXISTING_COMPANY,
    (_event, meetingId: string, companyId: string) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!companyId) throw new Error('companyId is required')
      const userId = getCurrentUserId()

      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      const company = getCompany(companyId)
      if (!company) throw new Error('Company not found')

      linkMeetingCompany(meetingId, companyId, 1, 'manual', userId)

      // Update the denormalized companies cache on the meeting row
      const updatedCompanies = appendCompanyIfMissing(meeting.companies, company.canonicalName)
      if (updatedCompanies !== meeting.companies) {
        meetingRepo.updateMeeting(meetingId, { companies: updatedCompanies }, userId)
      }

      logAudit(userId, 'meeting', meetingId, 'link_company', { companyId })
      return meetingRepo.getMeeting(meetingId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_UNLINK_COMPANY,
    (_event, meetingId: string, companyId: string) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!companyId) throw new Error('companyId is required')
      const userId = getCurrentUserId()

      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      const company = getCompany(companyId)
      if (!company) throw new Error('Company not found')

      unlinkMeetingCompany(meetingId, companyId)

      // Update the denormalized companies cache (mirror of MEETING_LINK_EXISTING_COMPANY)
      const updatedCompanies = removeCompanyFromList(meeting.companies, company.canonicalName)
      meetingRepo.updateMeeting(meetingId, { companies: updatedCompanies }, userId)

      logAudit(userId, 'meeting', meetingId, 'unlink_company', { companyId })
      return meetingRepo.getMeeting(meetingId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SWAP_COMPANY,
    (_event, meetingId: string, oldCompanyId: string | null, newCompanyName: string) => {
      if (!meetingId) throw new Error('meetingId is required')
      if (!newCompanyName?.trim()) throw new Error('newCompanyName is required')
      const userId = getCurrentUserId()

      const meeting = meetingRepo.getMeeting(meetingId)
      if (!meeting) throw new Error('Meeting not found')

      // Find or create the target company
      const newCompany = getOrCreateCompanyByName(newCompanyName.trim(), userId)

      // Unlink old company if it exists and is different from the new one
      if (oldCompanyId && oldCompanyId !== newCompany.id) {
        const oldCompany = getCompany(oldCompanyId)
        if (oldCompany) {
          unlinkMeetingCompany(meetingId, oldCompanyId)
          const stripped = removeCompanyFromList(meeting.companies, oldCompany.canonicalName)
          meetingRepo.updateMeeting(meetingId, { companies: stripped }, userId)
          logAudit(userId, 'meeting', meetingId, 'unlink_company', { companyId: oldCompanyId })

          // Update the domain→name cache so email-derived suggestions reflect the swap.
          // We update any domain that currently maps to the old company's name — this
          // covers both the old company's primary domain and email domains for this meeting
          // (e.g. angellist.com was cached as "Wellfound" → now maps to "AngelList").
          const domainsToUpdate = new Set<string>()
          if (oldCompany.primaryDomain) domainsToUpdate.add(oldCompany.primaryDomain)
          for (const email of (meeting.attendeeEmails ?? [])) {
            const d = extractDomainFromEmail(email)
            if (d) {
              const cached = getCompanyCacheByDomain(d)
              if (cached && cached.displayName === oldCompany.canonicalName) domainsToUpdate.add(d)
            }
          }
          for (const d of domainsToUpdate) {
            upsertCompanyCache(d, newCompany.canonicalName)
          }
        }
      }

      // Link new company (idempotent — INSERT OR IGNORE in linkMeetingCompany)
      linkMeetingCompany(meetingId, newCompany.id, 1, 'manual', userId)
      const refreshed = meetingRepo.getMeeting(meetingId)!
      const updated = appendCompanyIfMissing(refreshed.companies, newCompany.canonicalName)
      if (updated !== refreshed.companies) {
        meetingRepo.updateMeeting(meetingId, { companies: updated }, userId)
      }

      logAudit(userId, 'meeting', meetingId, 'swap_company', { oldCompanyId, newCompanyId: newCompany.id })
      return meetingRepo.getMeeting(meetingId)
    }
  )
}
