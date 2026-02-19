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
import type { ChatMessage, MeetingListFilter } from '../../shared/types/meeting'

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
    return meetingRepo.updateMeeting(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_DELETE, (_event, id: string) => {
    const meeting = meetingRepo.getMeeting(id)
    if (meeting) {
      if (meeting.transcriptPath) deleteTranscript(meeting.transcriptPath)
      if (meeting.summaryPath) deleteSummary(meeting.summaryPath)
      if (meeting.recordingPath) deleteRecording(meeting.recordingPath)
      removeFromIndex(id)
    }
    return meetingRepo.deleteMeeting(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_SPEAKERS,
    (_event, id: string, newSpeakerMap: Record<number, string>) => {
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      const oldSpeakerMap = meeting.speakerMap

      // Update speaker map in DB
      meetingRepo.updateMeeting(id, { speakerMap: newSpeakerMap })

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

      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_RENAME_TITLE,
    (_event, id: string, newTitle: string) => {
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')

      const trimmed = newTitle.trim()
      if (!trimmed || trimmed === meeting.title) return meeting

      const updates: Parameters<typeof meetingRepo.updateMeeting>[1] = { title: trimmed }

      if (meeting.transcriptPath) {
        updates.transcriptPath = renameTranscript(meeting.transcriptPath, id, trimmed, meeting.date, meeting.attendees)
      }
      if (meeting.summaryPath) {
        updates.summaryPath = renameSummary(meeting.summaryPath, id, trimmed, meeting.date, meeting.attendees)
      }
      if (meeting.recordingPath) {
        updates.recordingPath = renameRecording(meeting.recordingPath, id, trimmed, meeting.date, meeting.attendees)
      }

      meetingRepo.updateMeeting(id, updates)

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

      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_NOTES,
    (_event, id: string, notes: string) => {
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')
      meetingRepo.updateMeeting(id, { notes: notes || null })
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_SUMMARY,
    (_event, id: string, summaryContent: string) => {
      const meeting = meetingRepo.getMeeting(id)
      if (!meeting) throw new Error('Meeting not found')
      if (!meeting.summaryPath) throw new Error('Meeting has no summary file')
      updateSummaryContent(meeting.summaryPath, summaryContent)
      return meetingRepo.getMeeting(id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEETING_SAVE_CHAT,
    (_event, id: string, messages: ChatMessage[]) => {
      meetingRepo.updateMeeting(id, { chatMessages: messages })
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEETING_CREATE, () => {
    return meetingRepo.createMeeting({
      title: `Note ${new Date().toLocaleDateString()}`,
      date: new Date().toISOString(),
      status: 'scheduled'
    })
  })

  ipcMain.handle(
    IPC_CHANNELS.MEETING_PREPARE,
    (_event, calendarEventId: string, title: string, date: string, platform?: string, meetingUrl?: string, attendees?: string[], attendeeEmails?: string[]) => {
      // Check if a meeting already exists for this calendar event
      const existing = meetingRepo.findMeetingByCalendarEventId(calendarEventId)
      if (existing) return existing

      // Use heuristic names for immediate response
      const companies = attendeeEmails && attendeeEmails.length > 0
        ? extractCompaniesFromEmails(attendeeEmails)
        : extractCompaniesFromAttendees(attendees || [])

      // Create a new meeting with 'scheduled' status
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
      })

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

  ipcMain.handle(IPC_CHANNELS.APP_GET_STORAGE_PATH, () => {
    return getStoragePath()
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
