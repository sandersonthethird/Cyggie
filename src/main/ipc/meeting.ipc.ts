import { ipcMain, shell, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as meetingRepo from '../database/repositories/meeting.repo'
import * as settingsRepo from '../database/repositories/settings.repo'
import { readTranscript, readSummary, updateTranscriptContent, updateSummaryContent, deleteTranscript, deleteSummary, deleteRecording, renameTranscript, renameSummary, renameRecording } from '../storage/file-manager'
import { removeFromIndex } from '../database/repositories/search.repo'
import { getStoragePath, setStoragePath } from '../storage/paths'
import { renameFile as renameDriveFile } from '../drive/google-drive'
import { extractCompaniesFromEmails, extractCompaniesFromAttendees } from '../utils/company-extractor'
import { enrichCompaniesForMeeting, getCompanySuggestionsForMeeting } from '../services/company-enrichment'
import { syncContactsFromAttendees } from '../database/repositories/contact.repo'
import type { ChatMessage, MeetingListFilter } from '../../shared/types/meeting'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

export function registerMeetingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MEETING_LIST, (_event, filter?: MeetingListFilter) => {
    return meetingRepo.listMeetings(filter)
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_GET, (_event, id: string) => {
    const meeting = meetingRepo.getMeeting(id)
    if (!meeting) return null

    const transcript = meeting.transcriptPath ? readTranscript(meeting.transcriptPath) : null
    const summary = meeting.summaryPath ? readSummary(meeting.summaryPath) : null

    return { meeting, transcript, summary }
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
      return getCompanySuggestionsForMeeting(meeting.attendeeEmails, meeting.companies)
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
}
