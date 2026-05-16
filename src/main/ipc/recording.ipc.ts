import { ipcMain, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { AudioCapture } from '../audio/capture'
import { AudioStreamManager } from '../audio/stream-manager'
import { DeepgramStreamingClient } from '../deepgram/client'
import { TranscriptAssembler } from '../deepgram/transcript-assembler'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { getCredential } from '../security/credentials'
import { getSetting } from '../database/repositories/settings.repo'
import { writeTranscript } from '../storage/file-manager'
import { indexMeeting } from '../database/repositories/search.repo'
import { updateTrayMenu } from '../tray'
import { getCurrentMeetingEvent, getEventById } from '../calendar/google-calendar'
import { isCalendarConnected, hasDriveScope } from '../calendar/google-auth'
import { uploadTranscript } from '../drive/google-drive'
import { getTranscriptsDir } from '../storage/paths'
import { join } from 'path'
import { RecordingAutoStop } from '../recording/auto-stop'
import { extractCompaniesFromEmails } from '../utils/company-extractor'
import { syncContactsFromAttendees, listContactsLight } from '../database/repositories/contact.repo'
import { listCompanies } from '../database/repositories/org-company.repo'
import { correctProperNouns } from '../utils/proper-noun-corrector'
import { getCurrentUserId, getCurrentUserProfile } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import type { TranscriptResult } from '../deepgram/types'
import type { TranscriptSegment } from '../../shared/types/recording'
import { DEFAULT_DEEPGRAM_KEYWORDS } from '../../shared/constants/deepgram-keywords'
import { addPending, removePending, getPending } from './_finalizations'
import { broadcast } from './_broadcast'

let audioCapture: AudioCapture | null = null
let deepgramClient: DeepgramStreamingClient | null = null
let transcriptAssembler: TranscriptAssembler | null = null
let autoStop: RecordingAutoStop | null = null
let currentMeetingId: string | null = null
let recordingStartTime: number | null = null
let isPaused = false
let monoMode = false
let switchingToMono = false
let deepgramApiKey: string | null = null
let deepgramMaxSpeakers: number | undefined
let deepgramKeytermsCache: string[] = []
let calendarSelfName: string | null = null
let calendarAttendees: string[] = []
let calendarAttendeeEmails: string[] = []
let calendarEndTime: string | null = null
const DEBUG_TRANSCRIPTION =
  process.env['NODE_ENV'] === 'development' && process.env['GORP_DEBUG_TRANSCRIPTION'] === '1'

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

/**
 * Reset all module-level recording state to "not recording". Called from
 * the sync phase of RECORDING_STOP *before* the background finalize IIFE
 * starts, so a subsequent RECORDING_START sees a clean slate even while
 * the previous meeting's transcript is still being written in the
 * background.
 *
 * Single source of truth — adding new module state for recording must
 * also be reset here, or it will leak across recordings.
 */
function resetRecordingState(): void {
  audioCapture = null
  deepgramClient = null
  transcriptAssembler = null
  autoStop = null
  currentMeetingId = null
  recordingStartTime = null
  isPaused = false
  monoMode = false
  switchingToMono = false
  deepgramApiKey = null
  deepgramMaxSpeakers = undefined
  deepgramKeytermsCache = []
  calendarSelfName = null
  calendarAttendees = []
  calendarAttendeeEmails = []
  calendarEndTime = null
}

/** Dev-only step timer for the background finalize pipeline. */
function timeStep<T>(label: string, fn: () => T): T {
  if (!import.meta.env.DEV) return fn()
  const start = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - start
    console.debug(`[recording-finalize] ${label} ${ms.toFixed(1)}ms`)
  }
}

async function timeStepAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!import.meta.env.DEV) return fn()
  const start = performance.now()
  try {
    return await fn()
  } finally {
    const ms = performance.now() - start
    console.debug(`[recording-finalize] ${label} ${ms.toFixed(1)}ms`)
  }
}

function sendToRenderer(channel: string, data: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

async function openMeetingUrlInBrowser(url: string): Promise<void> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    // Inject authuser for Google Meet so the browser opens with the right account
    if (parsed.hostname === 'meet.google.com') {
      try {
        const email = getCurrentUserProfile().email
        if (email) parsed.searchParams.set('authuser', email)
      } catch {
        // Non-fatal: open without authuser if profile unavailable
      }
    }
    await shell.openExternal(parsed.toString())
  } catch (err) {
    console.warn('[Recording] Failed to open meeting URL:', err)
  }
}

function buildDeepgramKeyterms(meetingTitle: string | undefined, attendees: string[]): string[] {
  const terms = new Set<string>()

  // Keep a compact base list to reduce request-size risk while still boosting common terms.
  for (const keyword of DEFAULT_DEEPGRAM_KEYWORDS.slice(0, 60)) {
    if (keyword.trim()) terms.add(keyword.trim())
  }

  if (meetingTitle) {
    const normalizedTitle = meetingTitle.trim()
    if (normalizedTitle) {
      terms.add(normalizedTitle)
      const titleParts = normalizedTitle
        .split(/[\s,:;()<>/\\-]+/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 3)
      for (const part of titleParts) {
        terms.add(part)
      }
    }
  }

  for (const attendee of attendees) {
    const clean = attendee.trim()
    if (!clean) continue
    terms.add(clean)
    const firstToken = clean.split(/\s+/)[0]
    if (firstToken && firstToken.length >= 3) terms.add(firstToken)
  }

  return [...terms].slice(0, 100)
}

function wireDeepgramEvents(client: DeepgramStreamingClient): void {
  client.on('transcript', (result: TranscriptResult) => {
    if (DEBUG_TRANSCRIPTION) {
      console.log('[Recording] Deepgram transcript received:', {
        text: result.text,
        isFinal: result.isFinal,
        speechFinal: result.speechFinal,
        fromFinalize: result.fromFinalize,
        wordCount: result.words?.length || 0
      })
    }
    transcriptAssembler?.addResult(result)

    const interim = transcriptAssembler?.getInterimSegment()
    const finalized = transcriptAssembler?.getFinalizedSegments()
    const speakerCount = transcriptAssembler?.getSpeakerCount() || 0

    if (result.isFinal && finalized && finalized.length > 0) {
      autoStop?.onSpeechDetected()
      const lastSegment = finalized[finalized.length - 1]
      sendToRenderer(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE, { ...lastSegment, isFinal: true })
    } else if (interim) {
      autoStop?.onSpeechDetected()
      sendToRenderer(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE, { ...interim, isFinal: false })
    }

    sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, {
      isRecording: true,
      isPaused,
      meetingId: currentMeetingId,
      startTime: recordingStartTime,
      durationSeconds: Math.floor((Date.now() - (recordingStartTime || Date.now())) / 1000),
      speakerCount,
      channelMode: transcriptAssembler?.getChannelMode() || 'detecting'
    })
  })

  client.on('error', (error: unknown) => {
    console.error('[Recording] Deepgram error:', error)
    sendToRenderer(IPC_CHANNELS.RECORDING_ERROR, String(error))
  })

  client.on('connected', () => {
    console.log('[Recording] Deepgram connected successfully')
    sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, {
      isRecording: true,
      isPaused: false,
      meetingId: currentMeetingId,
      startTime: recordingStartTime,
      durationSeconds: 0,
      speakerCount: 0,
      channelMode: transcriptAssembler?.getChannelMode() || 'detecting'
    })
  })
}

/**
 * Determines the calendarEventId to assign to a newly created meeting.
 * If a recent prior meeting already claimed this ID (but can't be reused —
 * e.g. it's already transcribed), null it out to prevent a duplicate association.
 * If the prior meeting is old/stale (recurring event), preserve the ID so today's
 * recording is correctly linked to today's occurrence.
 */
export function resolveRecordingCalendarEventId(
  priorMeeting: { id: string } | null | undefined,
  meetingIsRecent: boolean,
  calendarEventId: string | null
): string | null {
  return (priorMeeting && meetingIsRecent) ? null : calendarEventId
}

export function registerRecordingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.RECORDING_START, async (_event, title?: string, calEventId?: string, appendToMeetingId?: string) => {
    if (currentMeetingId) {
      if (calEventId) {
        const currentMeeting = meetingRepo.getMeeting(currentMeetingId)
        if (currentMeeting?.calendarEventId === calEventId) {
          console.log('[Recording] Already recording this calendar event, returning existing:', currentMeetingId)
          return { meetingId: currentMeetingId, meetingPlatform: currentMeeting.meetingPlatform, alreadyRecording: true }
        }
      }
      throw new Error('Already recording')
    }

    // Same-meeting race: if a previous RECORDING_STOP is still finalizing the
    // transcript for the meeting we're about to (re-)start, wait for it. The
    // background's `meetingRepo.updateMeeting({status:'transcribed', transcriptSegments, ...})`
    // would otherwise race with our about-to-be-created fresh transcript and
    // could overwrite work-in-progress data. This adds at most a few seconds
    // to "Continue Recording" only when the user clicks it before the previous
    // finalize has flushed.
    if (appendToMeetingId) {
      const pending = getPending('recording', appendToMeetingId)
      if (pending) {
        console.log(`[Recording] Awaiting previous finalize for ${appendToMeetingId} before continuing`)
        await pending
      }
    }

    const userId = getCurrentUserId()

    const deepgramKey = getCredential('deepgramApiKey')
    if (!deepgramKey) {
      throw new Error('Deepgram API key not configured. Go to Settings to add it.')
    }

    // Reset calendar-derived metadata to avoid bleeding between adjacent meetings.
    calendarSelfName = null
    calendarAttendees = []
    calendarAttendeeEmails = []
    calendarEndTime = null

    // Initialize components (Deepgram client created below after speaker count is known)
    transcriptAssembler = new TranscriptAssembler()
    audioCapture = new AudioCapture()
    let maxSpeakers: number | undefined
    let expectedSpeakerCount: number | undefined
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
          expectedSpeakerCount = speakers.length
        }
      }

      meetingRepo.updateMeeting(appendToMeetingId, { status: 'recording' }, userId)
      try {
        syncContactsFromAttendees(existing.attendees, existing.attendeeEmails, userId)
      } catch (err) {
        console.error('[Contacts] Failed to sync from appended meeting:', err)
      }
      currentMeetingId = appendToMeetingId
      recordingStartTime = Date.now()
    } else {
      // Auto-suggest title from calendar if available
      let meetingTitle = title
      let calendarEventId: string | null = calEventId || null
      let meetingUrl: string | null = null

      if (isCalendarConnected()) {
        try {
          let calEvent = null
          if (calendarEventId) {
            calEvent = await getEventById(calendarEventId)
            if (!calEvent) {
              const current = await getCurrentMeetingEvent()
              if (current && current.id === calendarEventId) {
                calEvent = current
              }
            }
          } else {
            calEvent = await getCurrentMeetingEvent()
          }
          if (calEvent) {
            if (!meetingTitle) meetingTitle = calEvent.title
            if (!calendarEventId) calendarEventId = calEvent.id
            meetingPlatform = calEvent.platform
            meetingUrl = calEvent.meetingUrl
            calendarSelfName = calEvent.selfName
            calendarAttendees = calEvent.attendees
            calendarAttendeeEmails = calEvent.attendeeEmails
            calendarEndTime = calEvent.endTime
            // Auto-open meeting link so the user doesn't have to navigate manually
            if (meetingUrl) {
              void openMeetingUrlInBrowser(meetingUrl)
            }
          }
        } catch {
          // Calendar lookup failed, use default title
        }
      }

      // Set max speakers from calendar attendees (self + attendees)
      if (calendarAttendees.length > 0) {
        maxSpeakers = 1 + calendarAttendees.length
        expectedSpeakerCount = 1 + calendarAttendees.length
      } else {
        // Fall back to user's default setting for ad-hoc recordings
        const defaultMax = getSetting('defaultMaxSpeakers')
        if (defaultMax) {
          maxSpeakers = parseInt(defaultMax, 10) || 2
        } else {
          // Default to 2 speakers (most common case: 1-on-1 calls)
          maxSpeakers = 2
        }
        expectedSpeakerCount = maxSpeakers
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
      let createdNewMeeting = false

      const now = Date.now()
      const twentyFourHours = 24 * 60 * 60 * 1000
      const meetingIsRecent = meeting && Math.abs(new Date(meeting.date).getTime() - now) < twentyFourHours

      // Handle meeting stuck in 'recording' with no active session (post-crash/restart)
      if (meeting && meeting.status === 'recording' && !currentMeetingId && meetingIsRecent) {
        console.log('[Recording] Meeting stuck in recording state post-restart, returning existing:', meeting.id)
        return { meetingId: meeting.id, meetingPlatform: meeting.meetingPlatform, alreadyRecording: true }
      }

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
        meeting = meetingRepo.updateMeeting(meeting.id, updates, userId) || meeting
      } else {
        // If a recent prior meeting already claimed this calendarEventId (e.g. already
        // transcribed same day), don't propagate it — prevents a duplicate card in the
        // activity feed on back-to-back recordings. Old/stale meetings (recurring events,
        // !meetingIsRecent) still get the ID so today's recording links to today's event.
        if (meeting && meetingIsRecent) {
          console.log('[Recording] Clearing calendarEventId for new recording — recent prior meeting already claimed it:', calendarEventId, '(status:', meeting.status, ')')
        }
        const newCalendarEventId = resolveRecordingCalendarEventId(meeting, !!meetingIsRecent, calendarEventId)
        meeting = meetingRepo.createMeeting({
          title: meetingTitle,
          date: new Date().toISOString(),
          calendarEventId: newCalendarEventId,
          meetingPlatform: meetingPlatform as import('../../shared/constants/meeting-apps').MeetingPlatform | null,
          meetingUrl,
          attendees: calendarAttendees.length > 0 ? calendarAttendees : null,
          attendeeEmails: calendarAttendeeEmails.length > 0 ? calendarAttendeeEmails : null,
          companies: calendarAttendeeEmails.length > 0 ? extractCompaniesFromEmails(calendarAttendeeEmails) : null
        }, userId)
        createdNewMeeting = true
      }

      if (createdNewMeeting) {
        logAudit(userId, 'meeting', meeting.id, 'create', {
          source: 'recording-start',
          calendarEventId: calendarEventId ?? null
        })
      }

      try {
        syncContactsFromAttendees(meeting.attendees, meeting.attendeeEmails, userId)
      } catch (err) {
        console.error('[Contacts] Failed to sync from recording start:', err)
      }

      currentMeetingId = meeting.id
      recordingStartTime = Date.now()
    }
    transcriptAssembler.setExpectedSpeakerCount(expectedSpeakerCount)

    const meetingForKeywords = currentMeetingId ? meetingRepo.getMeeting(currentMeetingId) : null
    const deepgramKeyterms = buildDeepgramKeyterms(
      meetingForKeywords?.title,
      meetingForKeywords?.attendees || calendarAttendees
    )

    // Store config for potential mono reconnection later
    deepgramApiKey = deepgramKey
    deepgramMaxSpeakers = maxSpeakers
    deepgramKeytermsCache = deepgramKeyterms

    // Create Deepgram client with speaker count constraint and multichannel audio
    deepgramClient = new DeepgramStreamingClient({
      apiKey: deepgramKey,
      maxSpeakers,
      channels: 2,
      keyterms: deepgramKeyterms
    })

    // Wire audio -> Deepgram (stereo-to-mono conversion when monoMode is active)
    audioCapture.on('audio-chunk', (chunk: Buffer) => {
      if (DEBUG_TRANSCRIPTION) {
        console.log('[Recording] Audio chunk received:', chunk.length, 'bytes')
      }
      if (monoMode) {
        deepgramClient?.sendAudio(AudioStreamManager.stereoToMono(chunk))
      } else {
        deepgramClient?.sendAudio(chunk)
      }
    })

    wireDeepgramEvents(deepgramClient)

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
    // Reconnect Deepgram in mono mode for better diarization on a single mic channel
    if (!hasSystemAudio && currentMeetingId && deepgramClient && deepgramApiKey && !switchingToMono && !monoMode) {
      switchingToMono = true
      console.log('[Recording] Switching Deepgram to mono mode for diarization')

      const oldClient = deepgramClient
      oldClient.close().catch((err) => {
        console.warn('[Recording] Error closing stereo Deepgram client:', err)
      })

      const newClient = new DeepgramStreamingClient({
        apiKey: deepgramApiKey,
        maxSpeakers: deepgramMaxSpeakers,
        channels: 1,
        keyterms: deepgramKeytermsCache
      })
      wireDeepgramEvents(newClient)
      deepgramClient = newClient
      monoMode = true

      newClient.connect().then(() => {
        console.log('[Recording] Deepgram reconnected in mono mode')
      }).catch((err) => {
        console.error('[Recording] Failed to reconnect Deepgram in mono mode:', err)
        sendToRenderer(IPC_CHANNELS.RECORDING_ERROR, 'Failed to reconnect transcription in mono mode.')
      }).finally(() => {
        switchingToMono = false
      })
    }
  })

  // Receive audio data from renderer (for microphone/system capture done in renderer)
  ipcMain.on('recording:audio-data', (_event, data: ArrayBuffer) => {
    if (DEBUG_TRANSCRIPTION) {
      console.log('[Recording] Audio data from renderer:', data.byteLength, 'bytes')
    }
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
      speakerCount: transcriptAssembler?.getSpeakerCount() || 0,
      channelMode: transcriptAssembler?.getChannelMode() || 'detecting'
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
      speakerCount: transcriptAssembler?.getSpeakerCount() || 0,
      channelMode: transcriptAssembler?.getChannelMode() || 'detecting'
    })
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    if (!currentMeetingId) {
      throw new Error('Not recording')
    }

    // SYNC PHASE: snapshot everything the background work needs, then null
    // module state so the next RECORDING_START sees a clean slate. The
    // background IIFE closes over the locals — it doesn't read module state.
    const userId = getCurrentUserId()
    const meetingId = currentMeetingId
    const duration = recordingStartTime
      ? Math.floor((Date.now() - recordingStartTime) / 1000)
      : 0
    const snapshot = {
      deepgramClient,
      transcriptAssembler,
      calendarSelfName,
      calendarAttendees: calendarAttendees.slice(),
    }

    audioCapture?.stop()
    autoStop?.stop()
    resetRecordingState()

    const win = getMainWindow()
    if (win) updateTrayMenu(win, false)

    // BACKGROUND: deepgram flush, transcript assembly, DB writes, drive
    // upload. UI is already unblocked. Broadcasts a finalize event so the
    // renderer can refresh the meeting view + run auto-enhance.
    const finalizePromise = (async () => {
      try {
        try {
          await timeStepAsync('deepgram-close', () => snapshot.deepgramClient?.finalizeAndClose({
            quietMs: 900,
            maxWaitMs: 9000,
            closeWaitMs: 3500,
          }) ?? Promise.resolve())
        } catch (err) {
          console.warn('[Recording] Deepgram finalize close failed, forcing close:', err)
          await snapshot.deepgramClient?.close()
        }

        const meeting = meetingRepo.getMeeting(meetingId)
        const assembler = snapshot.transcriptAssembler
        if (assembler) {
          timeStep('transcript-assemble', () => {
            assembler.finalize()
            assembler.correctSpeakerBoundaries()
          })

          const diagnostics = assembler.getDiagnostics()
          console.log(
            '[Recording] Transcript diagnostics:',
            `mode=${diagnostics.channelMode}`,
            `speakers=${diagnostics.speakerCount}`,
            `segments=${diagnostics.totalSegments}`,
            `suppressedSwitches=${diagnostics.totalSuppressedSwitches}`,
          )

          if (snapshot.calendarAttendees.length > 0) {
            const expectedSpeakers = 1 + snapshot.calendarAttendees.length
            assembler.consolidateSpeakers(expectedSpeakers)
          }

          const actualSpeakerIds = assembler.getFinalizedSpeakerIds()
          const speakerCount = actualSpeakerIds.size

          const allNames: string[] = []
          if (snapshot.calendarSelfName || snapshot.calendarAttendees.length > 0) {
            allNames.push(snapshot.calendarSelfName || 'You')
            allNames.push(...snapshot.calendarAttendees)
          }

          const speakerMap: Record<number, string> = {}
          const detectedMode = assembler.getChannelMode()
          if (detectedMode === 'multichannel') {
            for (const id of actualSpeakerIds) {
              speakerMap[id] = allNames[id] || `Speaker ${id + 1}`
            }
          } else {
            const sortedIds = [...actualSpeakerIds].sort((a, b) => a - b)
            for (let i = 0; i < sortedIds.length; i++) {
              speakerMap[sortedIds[i]] = allNames[i] || `Speaker ${sortedIds[i] + 1}`
            }
          }

          const rawTranscriptMd = assembler.toMarkdown(speakerMap)

          let transcriptMd = rawTranscriptMd
          try {
            transcriptMd = timeStep('name-correction', () => {
              const contactNames = listContactsLight({ limit: 200 }).map((c) => c.fullName).filter(Boolean) as string[]
              const companyNames = listCompanies({ view: 'all' }).map((c) => c.canonicalName).filter(Boolean) as string[]
              const crmNames = [...contactNames, ...companyNames]
              if (crmNames.length === 0) return rawTranscriptMd
              const lines = rawTranscriptMd.split('\n')
              return lines.map((line) =>
                line.startsWith('**') && line.includes('** [')
                  ? line
                  : correctProperNouns(line, crmNames),
              ).join('\n')
            })
          } catch (err) {
            console.warn('[Recording] Proper noun correction failed, using raw transcript:', err)
            transcriptMd = rawTranscriptMd
          }

          const transcriptPath = timeStep('write-transcript',
            () => writeTranscript(meetingId, transcriptMd, meeting?.title, meeting?.date, meeting?.attendees))
          const fullText = assembler.getFullText()

          timeStep('db-update', () => meetingRepo.updateMeeting(meetingId, {
            durationSeconds: duration,
            transcriptPath,
            transcriptSegments: assembler.getSerializableState(),
            speakerCount,
            speakerMap,
            status: 'transcribed',
          }, userId))
          logAudit(userId, 'meeting', meetingId, 'update', {
            status: 'transcribed',
            transcript: true,
          })

          if (meeting) {
            timeStep('fts-index', () => indexMeeting(meetingId, meeting.title, fullText))
          }

          if (hasDriveScope()) {
            const fullPath = join(getTranscriptsDir(), transcriptPath)
            uploadTranscript(fullPath)
              .then(({ driveId }) => {
                meetingRepo.updateMeeting(meetingId, { transcriptDriveId: driveId }, userId)
                console.log('[Drive] Transcript uploaded:', driveId)
              })
              .catch((err) => {
                console.error('[Drive] Failed to upload transcript:', err)
              })
          }
        }

        broadcast(IPC_CHANNELS.RECORDING_FINALIZED, { meetingId, durationSeconds: duration })
      } catch (err) {
        console.error(`[RECORDING_STOP] background finalize failed for ${meetingId}:`, err)
        try {
          meetingRepo.updateMeeting(meetingId, { status: 'error' }, userId)
        } catch (dbErr) {
          console.error('[RECORDING_STOP] best-effort error-status write also failed:', dbErr)
        }
        broadcast(IPC_CHANNELS.RECORDING_FINALIZE_ERROR, {
          meetingId,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        removePending('recording', meetingId)
      }
    })()
    addPending('recording', meetingId, finalizePromise)

    return { meetingId, duration }
  })
}
