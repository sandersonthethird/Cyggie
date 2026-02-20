import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { AudioCapture } from '../audio/capture'
import { DeepgramStreamingClient } from '../deepgram/client'
import { TranscriptAssembler } from '../deepgram/transcript-assembler'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { getCredential } from '../security/credentials'
import { getSetting } from '../database/repositories/settings.repo'
import { writeTranscript } from '../storage/file-manager'
import { indexMeeting } from '../database/repositories/search.repo'
import { updateTrayMenu } from '../tray'
import { getCurrentMeetingEvent } from '../calendar/google-calendar'
import { isCalendarConnected, hasDriveScope } from '../calendar/google-auth'
import { uploadTranscript } from '../drive/google-drive'
import { getTranscriptsDir } from '../storage/paths'
import { join } from 'path'
import { RecordingAutoStop } from '../recording/auto-stop'
import { extractCompaniesFromEmails } from '../utils/company-extractor'
import type { TranscriptResult } from '../deepgram/types'
import type { TranscriptSegment } from '../../shared/types/recording'

let audioCapture: AudioCapture | null = null
let deepgramClient: DeepgramStreamingClient | null = null
let transcriptAssembler: TranscriptAssembler | null = null
let autoStop: RecordingAutoStop | null = null
let currentMeetingId: string | null = null
let recordingStartTime: number | null = null
let isPaused = false
let calendarSelfName: string | null = null
let calendarAttendees: string[] = []
let calendarAttendeeEmails: string[] = []
let calendarEndTime: string | null = null

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

function sendToRenderer(channel: string, data: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

export function registerRecordingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (_event, title?: string, calEventId?: string, appendToMeetingId?: string) => {
    if (currentMeetingId) {
      throw new Error('Already recording')
    }

    const deepgramKey = getCredential('deepgramApiKey')
    if (!deepgramKey) {
      throw new Error('Deepgram API key not configured. Go to Settings to add it.')
    }

    // Initialize components (Deepgram client created below after speaker count is known)
    transcriptAssembler = new TranscriptAssembler()
    audioCapture = new AudioCapture()
    let maxSpeakers: number | undefined
    let meetingPlatform: string | null = null

    // Append to existing meeting
    if (appendToMeetingId) {
      const existing = meetingRepo.getMeeting(appendToMeetingId)
      if (!existing) throw new Error('Meeting not found')

      meetingPlatform = existing.meetingPlatform || null

      // Restore previous segments so new audio continues from where we left off
      if (existing.transcriptSegments && existing.transcriptSegments.length > 0) {
        transcriptAssembler.restoreSegments(existing.transcriptSegments)
      }

      // Preserve existing speaker map info
      if (existing.speakerMap) {
        const speakers = Object.values(existing.speakerMap)
        if (speakers.length > 0) {
          calendarSelfName = speakers[0] || null
          calendarAttendees = speakers.slice(1)
          maxSpeakers = speakers.length
        }
      }

      meetingRepo.updateMeeting(appendToMeetingId, { status: 'recording' })
      currentMeetingId = appendToMeetingId
      recordingStartTime = Date.now()
    } else {
      // Auto-suggest title from calendar if available
      let meetingTitle = title
      let calendarEventId: string | null = calEventId || null
      let meetingUrl: string | null = null

      if (isCalendarConnected()) {
        try {
          const calEvent = await getCurrentMeetingEvent()
          if (calEvent) {
            if (!meetingTitle) meetingTitle = calEvent.title
            if (!calendarEventId) calendarEventId = calEvent.id
            meetingPlatform = calEvent.platform
            meetingUrl = calEvent.meetingUrl
            calendarSelfName = calEvent.selfName
            calendarAttendees = calEvent.attendees
            calendarAttendeeEmails = calEvent.attendeeEmails
            calendarEndTime = calEvent.endTime
          }
        } catch {
          // Calendar lookup failed, use default title
        }
      }

      // Set max speakers from calendar attendees (self + attendees)
      if (calendarAttendees.length > 0) {
        maxSpeakers = 1 + calendarAttendees.length
      } else {
        // Fall back to user's default setting for ad-hoc recordings
        const defaultMax = getSetting('defaultMaxSpeakers')
        if (defaultMax) maxSpeakers = parseInt(defaultMax, 10) || undefined
      }

      if (!meetingTitle) {
        meetingTitle = `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`
      }

      // Reuse an existing scheduled meeting (from prep/notes) if one exists for this calendar event
      // BUT only if the meeting date is within 24 hours of now (to avoid reusing stale scheduled meetings
      // from past occurrences of recurring events that were never recorded)
      let meeting = calendarEventId
        ? meetingRepo.findMeetingByCalendarEventId(calendarEventId)
        : null

      const now = Date.now()
      const twentyFourHours = 24 * 60 * 60 * 1000
      const meetingIsRecent = meeting && Math.abs(new Date(meeting.date).getTime() - now) < twentyFourHours

      if (meeting && meeting.status === 'scheduled' && meetingIsRecent) {
        // Update attendees if we have them from calendar and meeting doesn't have them yet
        const updates: Parameters<typeof meetingRepo.updateMeeting>[1] = { status: 'recording' }
        if (calendarAttendees.length > 0 && !meeting.attendees) {
          updates.attendees = calendarAttendees
        }
        // Also update attendees if we have fresh ones from calendar (handles case where attendees changed)
        if (calendarAttendees.length > 0) {
          updates.attendees = calendarAttendees
        }
        if (calendarAttendeeEmails.length > 0) {
          updates.attendeeEmails = calendarAttendeeEmails
          updates.companies = extractCompaniesFromEmails(calendarAttendeeEmails)
        }
        meetingRepo.updateMeeting(meeting.id, updates)
      } else {
        meeting = meetingRepo.createMeeting({
          title: meetingTitle,
          date: new Date().toISOString(),
          calendarEventId,
          meetingPlatform: meetingPlatform as import('../../shared/constants/meeting-apps').MeetingPlatform | null,
          meetingUrl,
          attendees: calendarAttendees.length > 0 ? calendarAttendees : null,
          attendeeEmails: calendarAttendeeEmails.length > 0 ? calendarAttendeeEmails : null,
          companies: calendarAttendeeEmails.length > 0 ? extractCompaniesFromEmails(calendarAttendeeEmails) : null
        })
      }

      currentMeetingId = meeting.id
      recordingStartTime = Date.now()
    }

    // Create Deepgram client with speaker count constraint and multichannel audio
    deepgramClient = new DeepgramStreamingClient({ apiKey: deepgramKey, maxSpeakers, channels: 2 })

    // Wire audio -> Deepgram
    audioCapture.on('audio-chunk', (chunk: Buffer) => {
      console.log('[Recording] Audio chunk received:', chunk.length, 'bytes')
      deepgramClient?.sendAudio(chunk)
    })

    // Wire Deepgram -> transcript assembler -> renderer
    deepgramClient.on('transcript', (result: TranscriptResult) => {
      console.log('[Recording] Deepgram transcript received:', {
        text: result.text,
        isFinal: result.isFinal,
        speechFinal: result.speechFinal,
        wordCount: result.words?.length || 0
      })
      transcriptAssembler?.addResult(result)

      const interim = transcriptAssembler?.getInterimSegment()
      const finalized = transcriptAssembler?.getFinalizedSegments()
      const speakerCount = transcriptAssembler?.getSpeakerCount() || 0

      if (result.isFinal && finalized && finalized.length > 0) {
        autoStop?.onSpeechDetected()
        const lastSegment = finalized[finalized.length - 1]
        sendToRenderer(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE, { ...lastSegment, isFinal: true })
      } else if (interim) {
        // Also update speech detection for interim results - this prevents
        // false silence detection during continuous speech
        autoStop?.onSpeechDetected()
        sendToRenderer(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE, { ...interim, isFinal: false })
      }

      // Send status update
      sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, {
        isRecording: true,
        isPaused,
        meetingId: currentMeetingId,
        startTime: recordingStartTime,
        durationSeconds: Math.floor((Date.now() - (recordingStartTime || Date.now())) / 1000),
        speakerCount
      })
    })

    deepgramClient.on('error', (error: unknown) => {
      console.error('[Recording] Deepgram error:', error)
      sendToRenderer(IPC_CHANNELS.RECORDING_ERROR, String(error))
    })

    deepgramClient.on('connected', () => {
      console.log('[Recording] Deepgram connected successfully')
      sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, {
        isRecording: true,
        isPaused: false,
        meetingId: currentMeetingId,
        startTime: recordingStartTime,
        durationSeconds: 0,
        speakerCount: 0
      })
    })

    // Start everything
    console.log('[Recording] Starting Deepgram connection...')
    await deepgramClient.connect()
    console.log('[Recording] Starting audio capture...')
    audioCapture.start()

    // Start auto-stop detection
    autoStop = new RecordingAutoStop({
      onAutoStop: () => {
        console.log('[Recording] Auto-stop triggered, notifying renderer')
        sendToRenderer(IPC_CHANNELS.RECORDING_AUTO_STOP, null)
      },
      calendarEndTime: calendarEndTime || undefined
    })
    autoStop.start()

    // Update tray
    const win = getMainWindow()
    if (win) updateTrayMenu(win, true)

    return { meetingId: currentMeetingId, meetingPlatform }
  })

  // Receive system audio capture status from renderer
  ipcMain.on('recording:system-audio-status', (_event, hasSystemAudio: boolean) => {
    console.log('[Recording] System audio status from renderer:', hasSystemAudio)
    if (transcriptAssembler && !hasSystemAudio) {
      transcriptAssembler.setSystemAudioUnavailable()
    }
    // Warn the user if audio was lost mid-recording
    if (!hasSystemAudio && currentMeetingId) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send(
          IPC_CHANNELS.RECORDING_ERROR,
          'System audio capture was lost — transcription may be incomplete. Try stopping and restarting the recording.'
        )
      }
    }
  })

  // Receive audio data from renderer (for microphone/system capture done in renderer)
  ipcMain.on('recording:audio-data', (_event, data: ArrayBuffer) => {
    console.log('[Recording] Audio data from renderer:', data.byteLength, 'bytes')
    if (audioCapture) {
      audioCapture.feedAudioFromRenderer(Buffer.from(data))
    }
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_PAUSE, () => {
    if (!currentMeetingId || isPaused) return
    isPaused = true
    audioCapture?.pause()
    sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, {
      isRecording: true,
      isPaused: true,
      meetingId: currentMeetingId,
      startTime: recordingStartTime,
      durationSeconds: Math.floor((Date.now() - (recordingStartTime || Date.now())) / 1000),
      speakerCount: transcriptAssembler?.getSpeakerCount() || 0
    })
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_RESUME, () => {
    if (!currentMeetingId || !isPaused) return
    isPaused = false
    audioCapture?.resume()
    sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, {
      isRecording: true,
      isPaused: false,
      meetingId: currentMeetingId,
      startTime: recordingStartTime,
      durationSeconds: Math.floor((Date.now() - (recordingStartTime || Date.now())) / 1000),
      speakerCount: transcriptAssembler?.getSpeakerCount() || 0
    })
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    if (!currentMeetingId) {
      throw new Error('Not recording')
    }

    const meetingId = currentMeetingId
    const duration = recordingStartTime
      ? Math.floor((Date.now() - recordingStartTime) / 1000)
      : 0

    // Stop audio capture
    audioCapture?.stop()

    // Wait for Deepgram to process any remaining audio in flight
    // Need enough time for: network latency + Deepgram processing + utterance_end_ms (1500ms)
    await new Promise((resolve) => setTimeout(resolve, 4000))

    // Close Deepgram connection
    await deepgramClient?.close()

    // Finalize transcript - promote any pending interim segment
    const meeting = meetingRepo.getMeeting(meetingId)

    if (transcriptAssembler) {
      transcriptAssembler.finalize()
      transcriptAssembler.correctSpeakerBoundaries()

      // Merge phantom speakers created by Deepgram diarization.
      // When we know the expected participant count from the calendar,
      // short segments from extra speakers get folded into the prior speaker.
      if (calendarAttendees.length > 0) {
        const expectedSpeakers = 1 + calendarAttendees.length
        transcriptAssembler.consolidateSpeakers(expectedSpeakers)
      }

      // Build speaker labels only for speakers that actually appear in the
      // finalized transcript (post-processing may have eliminated some).
      const actualSpeakerIds = transcriptAssembler.getFinalizedSpeakerIds()
      const speakerCount = actualSpeakerIds.size

      const allNames: string[] = []
      if (calendarSelfName || calendarAttendees.length > 0) {
        allNames.push(calendarSelfName || 'You')
        allNames.push(...calendarAttendees)
      }

      const speakerMap: Record<number, string> = {}
      const detectedMode = transcriptAssembler.getChannelMode()
      if (detectedMode === 'multichannel') {
        // Multichannel: speaker 0 = self (mic channel), speaker 1+ = remote participants
        for (const id of actualSpeakerIds) {
          speakerMap[id] = allNames[id] || `Speaker ${id + 1}`
        }
      } else {
        // Diarization (or still detecting): Deepgram assigns speaker IDs
        // arbitrarily. Speaker 0 is NOT necessarily "self". Assign names
        // in sorted order; the user can rename speakers after the fact.
        const sortedIds = [...actualSpeakerIds].sort((a, b) => a - b)
        for (let i = 0; i < sortedIds.length; i++) {
          speakerMap[sortedIds[i]] = allNames[i] || `Speaker ${sortedIds[i] + 1}`
        }
      }

      const transcriptMd = transcriptAssembler.toMarkdown(speakerMap)
      const transcriptPath = writeTranscript(meetingId, transcriptMd, meeting?.title, meeting?.date, meeting?.attendees)
      const fullText = transcriptAssembler.getFullText()

      // Update meeting record
      meetingRepo.updateMeeting(meetingId, {
        durationSeconds: duration,
        transcriptPath,
        transcriptSegments: transcriptAssembler.getSerializableState(),
        speakerCount,
        speakerMap,
        status: 'transcribed'
      })

      // Index for search
      if (meeting) {
        indexMeeting(meetingId, meeting.title, fullText)
      }

      // Upload transcript to Drive (fire-and-forget)
      if (hasDriveScope()) {
        const fullPath = join(getTranscriptsDir(), transcriptPath)
        uploadTranscript(fullPath)
          .then(({ driveId }) => {
            meetingRepo.updateMeeting(meetingId, { transcriptDriveId: driveId })
            console.log('[Drive] Transcript uploaded:', driveId)
          })
          .catch((err) => {
            console.error('[Drive] Failed to upload transcript:', err)
          })
      }
    }

    // Cleanup
    autoStop?.stop()
    autoStop = null
    audioCapture = null
    deepgramClient = null
    transcriptAssembler = null
    currentMeetingId = null
    recordingStartTime = null
    isPaused = false
    calendarSelfName = null
    calendarAttendees = []
    calendarAttendeeEmails = []
    calendarEndTime = null

    // Update tray
    const win = getMainWindow()
    if (win) updateTrayMenu(win, false)

    return { meetingId, duration }
  })
}
