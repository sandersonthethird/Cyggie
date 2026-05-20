// =============================================================================
// RecordingSession — extracted recording state machine.
//
// Owns the audio→transcript→finalize pipeline that previously lived as 16
// module-level vars + a pile of helper functions in
// src/main/ipc/recording.ipc.ts. The IPC handler is now a thin adapter:
// instantiate a session, route ipcMain.handle calls through it, broadcast
// the session's emitted events to the renderer.
//
// Why a class:
//   • The gateway's mobile-recording route (M3) needs to instantiate one
//     of these per user — module-level singletons would cross-contaminate.
//   • Tests can mock the surface (callbacks + injected deps) without
//     spinning up a full Electron environment.
//   • A single resetRecordingState()-equivalent is unnecessary now —
//     each session is self-contained; the next recording is a new
//     instance.
//
// What's NOT in here (and why):
//   • Electron specifics: BrowserWindow, ipcMain, shell.openExternal,
//     webContents.send, tray menu. The class surfaces these as callbacks
//     (onTranscriptUpdate, onTrayUpdate, onOpenMeetingUrl, …) and the
//     desktop IPC handler wires them to Electron.
//   • The _finalizations addPending/removePending registry — that's
//     IPC-handler bookkeeping. start()/stop() return enough for the
//     handler to register the finalize promise itself.
//   • The "already recording this calendar event" idempotency check —
//     that's a desktop UX guard (renderer double-fire); IPC handler still
//     owns it.
//
// Lifecycle:
//   new RecordingSession(callbacks)         — cheap; no I/O
//      ↓
//   await session.start({ title?, calEventId?, appendToMeetingId? })
//      → resolves with { meetingId, meetingPlatform, meetingUrl? }
//      → after this point, session.isActive === true
//      ↓
//   session.feedAudio(chunk)                — from renderer audio-data IPC
//   session.onSystemAudioStatus(hasSys)     — from renderer hint
//   session.pause() / session.resume()
//      ↓
//   const { meetingId, durationSeconds, finalizePromise } = session.stop()
//      → returns SYNCHRONOUSLY after audio+autostop teardown; deepgram
//        flush + transcript assembly + DB write run inside finalizePromise
//      → after this point, session.isActive === false; instance is done
// =============================================================================

import { AudioCapture } from '@main/audio/capture'
import { AudioStreamManager } from '@main/audio/stream-manager'
import { DeepgramStreamingClient } from '@main/deepgram/client'
import { TranscriptAssembler } from '@main/deepgram/transcript-assembler'
import { RecordingAutoStop } from '@main/recording/auto-stop'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import {
  syncContactsFromAttendees,
  listContactsLight,
  shouldSyncAttendees,
  listCompanies,
} from '@cyggie/db/sqlite/repositories'
import { indexMeeting } from '@cyggie/db/sqlite/repositories/search.repo'
import { getSetting } from '@cyggie/db/sqlite/repositories/settings.repo'
import { logAudit } from '@cyggie/db/sqlite/repositories/audit.repo'
import { getCredential } from '@main/security/credentials'
import { getCurrentUserId } from '@main/security/current-user'
import { writeTranscript } from '@main/storage/file-manager'
import { getTranscriptsDir } from '@main/storage/paths'
import { getCurrentMeetingEvent, getEventById } from '@main/calendar/google-calendar'
import { isCalendarConnected, hasDriveScope } from '@main/calendar/google-auth'
import { uploadTranscript } from '@main/drive/google-drive'
import { extractCompaniesFromEmails } from '@main/utils/company-extractor'
import { correctProperNouns } from '@main/utils/proper-noun-corrector'
import { join } from 'path'
import { GROUP_EVENT_ATTENDEE_THRESHOLD } from '@cyggie/shared'
import { DEFAULT_DEEPGRAM_KEYWORDS } from '@shared/constants/deepgram-keywords'
import type { TranscriptResult } from '@main/deepgram/types'
import type { TranscriptSegment } from '@shared/types/recording'
import type { MeetingPlatform } from '@shared/constants/meeting-apps'

const DEBUG_TRANSCRIPTION =
  process.env['NODE_ENV'] === 'development' && process.env['GORP_DEBUG_TRANSCRIPTION'] === '1'

// ─── Pure helpers (previously module-private in recording.ipc.ts) ────────────

function buildDeepgramKeyterms(meetingTitle: string | undefined, attendees: string[]): string[] {
  const terms = new Set<string>()
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
      for (const part of titleParts) terms.add(part)
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

/**
 * If a recent prior meeting already claimed this calendarEventId, return
 * null to prevent a duplicate association on back-to-back recordings.
 * Stale meetings (>24h, recurring event) keep their ID so today's recording
 * is correctly linked to today's occurrence.
 *
 * Pure utility; exported for the existing recording-start.test.ts.
 */
export function resolveRecordingCalendarEventId(
  priorMeeting: { id: string } | null | undefined,
  meetingIsRecent: boolean,
  calendarEventId: string | null,
): string | null {
  return priorMeeting && meetingIsRecent ? null : calendarEventId
}

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

// ─── Public types ────────────────────────────────────────────────────────────

export interface RecordingStatusPayload {
  isRecording: boolean
  isPaused: boolean
  meetingId: string | null
  startTime: number | null
  durationSeconds: number
  speakerCount: number
  channelMode: string
}

export interface RecordingSessionCallbacks {
  onTranscriptUpdate(segment: TranscriptSegment & { isFinal: boolean }): void
  onStatus(payload: RecordingStatusPayload): void
  onError(message: string): void
  onAutoStop(): void
  /** Fires from the background finalize IIFE on success. */
  onFinalized(payload: { meetingId: string; durationSeconds: number }): void
  /** Fires from the background finalize IIFE on failure. */
  onFinalizeError(payload: { meetingId: string; error: string }): void
}

export interface RecordingSessionStartArgs {
  title?: string
  calEventId?: string
  /** If set, append to an existing meeting instead of creating a new one. */
  appendToMeetingId?: string
}

export interface RecordingSessionStartResult {
  meetingId: string
  meetingPlatform: MeetingPlatform | null
  /** Set when the calendar event includes a meeting URL (Meet/Zoom). The
   * caller (desktop IPC handler) opens this in the system browser. */
  meetingUrl: string | null
  /** True when start() detected the renderer was already recording this
   * calendar event and returned the existing session. */
  alreadyRecording?: boolean
}

export interface RecordingSessionStopResult {
  meetingId: string
  durationSeconds: number
  /** Resolves after background deepgram flush + transcript assembly + DB
   * write. Caller is responsible for tracking this in the
   * _finalizations registry so a same-meeting RECORDING_START can await it. */
  finalizePromise: Promise<void>
}

// ─── The session class ───────────────────────────────────────────────────────

export class RecordingSession {
  // 16 module-level vars → private instance fields. Same names + types
  // for grep continuity with the prior recording.ipc.ts.
  private audioCapture: AudioCapture | null = null
  private deepgramClient: DeepgramStreamingClient | null = null
  private transcriptAssembler: TranscriptAssembler | null = null
  private autoStop: RecordingAutoStop | null = null
  private currentMeetingId: string | null = null
  private recordingStartTime: number | null = null
  private isPaused = false
  private monoMode = false
  private switchingToMono = false
  private deepgramApiKey: string | null = null
  private deepgramMaxSpeakers: number | undefined
  private deepgramKeytermsCache: string[] = []
  private calendarSelfName: string | null = null
  private calendarAttendees: string[] = []
  private calendarAttendeeEmails: string[] = []
  private calendarEndTime: string | null = null
  /** Marks the instance as terminal — no further start()/stop() allowed. */
  private terminated = false

  constructor(private readonly callbacks: RecordingSessionCallbacks) {}

  get isActive(): boolean {
    return this.currentMeetingId !== null && !this.terminated
  }

  get meetingId(): string | null {
    return this.currentMeetingId
  }

  // ─── start() ───────────────────────────────────────────────────────────────

  async start(args: RecordingSessionStartArgs): Promise<RecordingSessionStartResult> {
    if (this.terminated) throw new Error('RecordingSession already stopped')
    if (this.currentMeetingId) throw new Error('Already recording')

    const { title, calEventId, appendToMeetingId } = args
    const userId = getCurrentUserId()

    const deepgramKey = getCredential('deepgramApiKey')
    if (!deepgramKey) {
      throw new Error('Deepgram API key not configured. Go to Settings to add it.')
    }

    // Calendar-derived metadata starts fresh on every start; we never
    // bleed from a prior session because each session is a new instance.
    // (Kept explicit for the appendToMeetingId path which only partially
    // populates these from the existing meeting's speakerMap.)
    this.calendarSelfName = null
    this.calendarAttendees = []
    this.calendarAttendeeEmails = []
    this.calendarEndTime = null

    this.transcriptAssembler = new TranscriptAssembler()
    this.audioCapture = new AudioCapture()
    let maxSpeakers: number | undefined
    let expectedSpeakerCount: number | undefined
    let meetingPlatform: MeetingPlatform | null = null
    let meetingUrl: string | null = null

    if (appendToMeetingId) {
      const existing = meetingRepo.getMeeting(appendToMeetingId)
      if (!existing) throw new Error('Meeting not found')

      meetingPlatform = (existing.meetingPlatform as MeetingPlatform | null) ?? null

      if (existing.transcriptSegments && existing.transcriptSegments.length > 0) {
        this.transcriptAssembler.restoreSegments(existing.transcriptSegments)
      }

      if (existing.speakerMap) {
        const speakers = Object.values(existing.speakerMap)
        if (speakers.length > 0) {
          this.calendarSelfName = speakers[0] || null
          this.calendarAttendees = speakers.slice(1)
          maxSpeakers = speakers.length
          expectedSpeakerCount = speakers.length
        }
      }

      meetingRepo.updateMeeting(appendToMeetingId, { status: 'recording' }, userId)
      // The redundant `syncContactsFromAttendees` call that used to live here
      // was removed (migration 098 / plan Part 2). It re-ran against unchanged
      // stored attendees on every recording-resume and was a resurrection
      // vector for user-deleted contacts. Re-syncing only happens on attendee
      // CHANGE via MEETING_UPDATE.
      this.currentMeetingId = appendToMeetingId
      this.recordingStartTime = Date.now()
    } else {
      let meetingTitle = title
      let calendarEventId: string | null = calEventId || null

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
            meetingPlatform = calEvent.platform as MeetingPlatform | null
            meetingUrl = calEvent.meetingUrl
            this.calendarSelfName = calEvent.selfName
            this.calendarAttendees = calEvent.attendees
            this.calendarAttendeeEmails = calEvent.attendeeEmails
            this.calendarEndTime = calEvent.endTime
          }
        } catch {
          // Calendar lookup failed — fall through with the user-provided title.
        }
      }

      if (this.calendarAttendees.length > 0) {
        maxSpeakers = 1 + this.calendarAttendees.length
        expectedSpeakerCount = 1 + this.calendarAttendees.length
      } else {
        const defaultMax = getSetting('defaultMaxSpeakers')
        maxSpeakers = defaultMax ? parseInt(defaultMax, 10) || 2 : 2
        expectedSpeakerCount = maxSpeakers
      }

      if (!meetingTitle) {
        meetingTitle = `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`
      }

      // Reuse an existing scheduled meeting (from prep/notes) if one
      // exists for this calendar event AND it's within 24 hours of now
      // (avoid reusing stale recurring-event meetings).
      let meeting = calendarEventId
        ? meetingRepo.findMeetingByCalendarEventId(calendarEventId)
        : null
      let createdNewMeeting = false

      const now = Date.now()
      const twentyFourHours = 24 * 60 * 60 * 1000
      const meetingIsRecent =
        meeting && Math.abs(new Date(meeting.date).getTime() - now) < twentyFourHours

      // Post-crash recovery: a meeting stuck in 'recording' with no live
      // session — return it instead of creating a duplicate.
      if (meeting && meeting.status === 'recording' && meetingIsRecent) {
        console.log(
          '[Recording] Meeting stuck in recording state post-restart, returning existing:',
          meeting.id,
        )
        return {
          meetingId: meeting.id,
          meetingPlatform: (meeting.meetingPlatform as MeetingPlatform | null) ?? null,
          meetingUrl: null,
          alreadyRecording: true,
        }
      }

      if (meeting && meeting.status === 'scheduled' && meetingIsRecent) {
        const updates: Parameters<typeof meetingRepo.updateMeeting>[1] = { status: 'recording' }
        if (this.calendarAttendees.length > 0) {
          updates.attendees = this.calendarAttendees
        }
        if (this.calendarAttendeeEmails.length > 0) {
          updates.attendeeEmails = this.calendarAttendeeEmails
          updates.companies = extractCompaniesFromEmails(this.calendarAttendeeEmails)
        }
        meeting = meetingRepo.updateMeeting(meeting.id, updates, userId) || meeting
      } else {
        if (meeting && meetingIsRecent) {
          console.log(
            '[Recording] Clearing calendarEventId for new recording — recent prior meeting already claimed it:',
            calendarEventId,
            '(status:',
            meeting.status,
            ')',
          )
        }
        const newCalendarEventId = resolveRecordingCalendarEventId(
          meeting,
          !!meetingIsRecent,
          calendarEventId,
        )
        // Group-event auto-flag at create (migration 098). Recording-flow
        // meetings often start with 0 attendees; the flag computes from
        // whatever calendar emails were available and stays put thereafter
        // (no auto-recompute on append).
        const isGroupEvent = this.calendarAttendeeEmails.length > GROUP_EVENT_ATTENDEE_THRESHOLD
        meeting = meetingRepo.createMeeting(
          {
            title: meetingTitle,
            date: new Date().toISOString(),
            calendarEventId: newCalendarEventId,
            meetingPlatform: meetingPlatform,
            meetingUrl,
            attendees: this.calendarAttendees.length > 0 ? this.calendarAttendees : null,
            attendeeEmails:
              this.calendarAttendeeEmails.length > 0 ? this.calendarAttendeeEmails : null,
            companies: isGroupEvent
              ? null
              : this.calendarAttendeeEmails.length > 0
                ? extractCompaniesFromEmails(this.calendarAttendeeEmails)
                : null,
            isGroupEvent,
          },
          userId,
        )
        createdNewMeeting = true
      }

      if (createdNewMeeting) {
        logAudit(userId, 'meeting', meeting.id, 'create', {
          source: 'recording-start',
          calendarEventId: calendarEventId ?? null,
        })
      }

      if (shouldSyncAttendees(meeting.id)) {
        try {
          syncContactsFromAttendees(meeting.attendees, meeting.attendeeEmails, userId)
        } catch (err) {
          console.error('[Contacts] Failed to sync from recording start:', err)
        }
      }

      this.currentMeetingId = meeting.id
      this.recordingStartTime = Date.now()
    }

    this.transcriptAssembler.setExpectedSpeakerCount(expectedSpeakerCount)

    const meetingForKeywords = this.currentMeetingId
      ? meetingRepo.getMeeting(this.currentMeetingId)
      : null
    const deepgramKeyterms = buildDeepgramKeyterms(
      meetingForKeywords?.title,
      meetingForKeywords?.attendees || this.calendarAttendees,
    )

    this.deepgramApiKey = deepgramKey
    this.deepgramMaxSpeakers = maxSpeakers
    this.deepgramKeytermsCache = deepgramKeyterms

    this.deepgramClient = new DeepgramStreamingClient({
      apiKey: deepgramKey,
      maxSpeakers,
      channels: 2,
      keyterms: deepgramKeyterms,
    })

    this.audioCapture.on('audio-chunk', (chunk: Buffer) => {
      if (DEBUG_TRANSCRIPTION) {
        console.log('[Recording] Audio chunk received:', chunk.length, 'bytes')
      }
      if (this.monoMode) {
        this.deepgramClient?.sendAudio(AudioStreamManager.stereoToMono(chunk))
      } else {
        this.deepgramClient?.sendAudio(chunk)
      }
    })

    this.wireDeepgramEvents(this.deepgramClient)

    console.log('[Recording] Starting Deepgram connection...')
    await this.deepgramClient.connect()
    console.log('[Recording] Starting audio capture...')
    this.audioCapture.start()

    this.autoStop = new RecordingAutoStop({
      onAutoStop: () => {
        console.log('[Recording] Auto-stop triggered, notifying handler')
        this.callbacks.onAutoStop()
      },
      calendarEndTime: this.calendarEndTime || undefined,
    })
    this.autoStop.start()

    return { meetingId: this.currentMeetingId!, meetingPlatform, meetingUrl }
  }

  // ─── audio + system-audio + pause/resume ───────────────────────────────────

  feedAudio(chunk: Buffer): void {
    if (DEBUG_TRANSCRIPTION) {
      console.log('[Recording] Audio data from renderer:', chunk.length, 'bytes')
    }
    this.audioCapture?.feedAudioFromRenderer(chunk)
  }

  onSystemAudioStatus(hasSystemAudio: boolean): void {
    console.log('[Recording] System audio status from renderer:', hasSystemAudio)
    if (this.transcriptAssembler && !hasSystemAudio) {
      this.transcriptAssembler.setSystemAudioUnavailable()
    }
    // Reconnect Deepgram in mono mode for better diarization on a single mic channel.
    if (
      !hasSystemAudio &&
      this.currentMeetingId &&
      this.deepgramClient &&
      this.deepgramApiKey &&
      !this.switchingToMono &&
      !this.monoMode
    ) {
      this.switchingToMono = true
      console.log('[Recording] Switching Deepgram to mono mode for diarization')

      const oldClient = this.deepgramClient
      oldClient.close().catch((err) => {
        console.warn('[Recording] Error closing stereo Deepgram client:', err)
      })

      const newClient = new DeepgramStreamingClient({
        apiKey: this.deepgramApiKey,
        maxSpeakers: this.deepgramMaxSpeakers,
        channels: 1,
        keyterms: this.deepgramKeytermsCache,
      })
      this.wireDeepgramEvents(newClient)
      this.deepgramClient = newClient
      this.monoMode = true

      newClient
        .connect()
        .then(() => console.log('[Recording] Deepgram reconnected in mono mode'))
        .catch((err) => {
          console.error('[Recording] Failed to reconnect Deepgram in mono mode:', err)
          this.callbacks.onError('Failed to reconnect transcription in mono mode.')
        })
        .finally(() => {
          this.switchingToMono = false
        })
    }
  }

  pause(): void {
    if (!this.currentMeetingId || this.isPaused) return
    this.isPaused = true
    this.audioCapture?.pause()
    this.emitStatus()
  }

  resume(): void {
    if (!this.currentMeetingId || !this.isPaused) return
    this.isPaused = false
    this.audioCapture?.resume()
    this.emitStatus()
  }

  // ─── stop() ────────────────────────────────────────────────────────────────

  /**
   * Returns synchronously after audio + autostop teardown. The deepgram
   * flush, transcript assembly, DB writes, and Drive upload run inside
   * `finalizePromise` — the caller (IPC handler) should register that
   * promise in the _finalizations registry so a same-meeting
   * RECORDING_START can await it.
   */
  stop(): RecordingSessionStopResult {
    if (!this.currentMeetingId) throw new Error('Not recording')

    const userId = getCurrentUserId()
    const meetingId = this.currentMeetingId
    const duration = this.recordingStartTime
      ? Math.floor((Date.now() - this.recordingStartTime) / 1000)
      : 0

    // Snapshot everything the background work needs into locals, then
    // null instance state so a subsequent .isActive check returns false.
    // (Instance is logically terminated after this; callers are expected
    // to discard the reference and create a new RecordingSession for the
    // next recording.)
    const snapshot = {
      deepgramClient: this.deepgramClient,
      transcriptAssembler: this.transcriptAssembler,
      calendarSelfName: this.calendarSelfName,
      calendarAttendees: this.calendarAttendees.slice(),
    }

    this.audioCapture?.stop()
    this.autoStop?.stop()

    this.audioCapture = null
    this.deepgramClient = null
    this.transcriptAssembler = null
    this.autoStop = null
    this.currentMeetingId = null
    this.recordingStartTime = null
    this.isPaused = false
    this.monoMode = false
    this.switchingToMono = false
    this.deepgramApiKey = null
    this.deepgramMaxSpeakers = undefined
    this.deepgramKeytermsCache = []
    this.calendarSelfName = null
    this.calendarAttendees = []
    this.calendarAttendeeEmails = []
    this.calendarEndTime = null
    this.terminated = true

    const finalizePromise = this.runBackgroundFinalize(snapshot, meetingId, userId, duration)

    return { meetingId, durationSeconds: duration, finalizePromise }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private async runBackgroundFinalize(
    snapshot: {
      deepgramClient: DeepgramStreamingClient | null
      transcriptAssembler: TranscriptAssembler | null
      calendarSelfName: string | null
      calendarAttendees: string[]
    },
    meetingId: string,
    userId: string,
    duration: number,
  ): Promise<void> {
    try {
      try {
        await timeStepAsync(
          'deepgram-close',
          () =>
            snapshot.deepgramClient?.finalizeAndClose({
              quietMs: 900,
              maxWaitMs: 9000,
              closeWaitMs: 3500,
            }) ?? Promise.resolve(),
        )
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
            const contactNames = listContactsLight({ limit: 200 })
              .map((c) => c.fullName)
              .filter(Boolean) as string[]
            const companyNames = listCompanies({ view: 'all' })
              .map((c) => c.canonicalName)
              .filter(Boolean) as string[]
            const crmNames = [...contactNames, ...companyNames]
            if (crmNames.length === 0) return rawTranscriptMd
            const lines = rawTranscriptMd.split('\n')
            return lines
              .map((line) =>
                line.startsWith('**') && line.includes('** [')
                  ? line
                  : correctProperNouns(line, crmNames),
              )
              .join('\n')
          })
        } catch (err) {
          console.warn('[Recording] Proper noun correction failed, using raw transcript:', err)
          transcriptMd = rawTranscriptMd
        }

        const transcriptPath = timeStep('write-transcript', () =>
          writeTranscript(meetingId, transcriptMd, meeting?.title, meeting?.date, meeting?.attendees),
        )
        const fullText = assembler.getFullText()

        timeStep('db-update', () =>
          meetingRepo.updateMeeting(
            meetingId,
            {
              durationSeconds: duration,
              transcriptPath,
              transcriptSegments: assembler.getSerializableState(),
              speakerCount,
              speakerMap,
              status: 'transcribed',
            },
            userId,
          ),
        )
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

      this.callbacks.onFinalized({ meetingId, durationSeconds: duration })
    } catch (err) {
      console.error(`[RECORDING_STOP] background finalize failed for ${meetingId}:`, err)
      try {
        meetingRepo.updateMeeting(meetingId, { status: 'error' }, userId)
      } catch (dbErr) {
        console.error('[RECORDING_STOP] best-effort error-status write also failed:', dbErr)
      }
      this.callbacks.onFinalizeError({
        meetingId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private wireDeepgramEvents(client: DeepgramStreamingClient): void {
    client.on('transcript', (result: TranscriptResult) => {
      if (DEBUG_TRANSCRIPTION) {
        console.log('[Recording] Deepgram transcript received:', {
          text: result.text,
          isFinal: result.isFinal,
          speechFinal: result.speechFinal,
          fromFinalize: result.fromFinalize,
          wordCount: result.words?.length || 0,
        })
      }
      this.transcriptAssembler?.addResult(result)

      const interim = this.transcriptAssembler?.getInterimSegment()
      const finalized = this.transcriptAssembler?.getFinalizedSegments()
      const speakerCount = this.transcriptAssembler?.getSpeakerCount() || 0

      if (result.isFinal && finalized && finalized.length > 0) {
        this.autoStop?.onSpeechDetected()
        const lastSegment = finalized[finalized.length - 1]
        this.callbacks.onTranscriptUpdate({ ...lastSegment, isFinal: true })
      } else if (interim) {
        this.autoStop?.onSpeechDetected()
        this.callbacks.onTranscriptUpdate({ ...interim, isFinal: false })
      }

      this.callbacks.onStatus({
        isRecording: true,
        isPaused: this.isPaused,
        meetingId: this.currentMeetingId,
        startTime: this.recordingStartTime,
        durationSeconds: Math.floor(
          (Date.now() - (this.recordingStartTime || Date.now())) / 1000,
        ),
        speakerCount,
        channelMode: this.transcriptAssembler?.getChannelMode() || 'detecting',
      })
    })

    client.on('error', (error: unknown) => {
      console.error('[Recording] Deepgram error:', error)
      this.callbacks.onError(String(error))
    })

    client.on('connected', () => {
      console.log('[Recording] Deepgram connected successfully')
      this.callbacks.onStatus({
        isRecording: true,
        isPaused: false,
        meetingId: this.currentMeetingId,
        startTime: this.recordingStartTime,
        durationSeconds: 0,
        speakerCount: 0,
        channelMode: this.transcriptAssembler?.getChannelMode() || 'detecting',
      })
    })
  }

  private emitStatus(): void {
    this.callbacks.onStatus({
      isRecording: true,
      isPaused: this.isPaused,
      meetingId: this.currentMeetingId,
      startTime: this.recordingStartTime,
      durationSeconds: Math.floor(
        (Date.now() - (this.recordingStartTime || Date.now())) / 1000,
      ),
      speakerCount: this.transcriptAssembler?.getSpeakerCount() || 0,
      channelMode: this.transcriptAssembler?.getChannelMode() || 'detecting',
    })
  }
}
