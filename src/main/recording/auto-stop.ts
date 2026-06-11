import { MeetingWindowWatcher } from './meeting-window-watcher'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'
import type { WindowSource } from '../audio/window-detector'

// Three concurrent triggers stop a recording.
//
//   Trigger 1: calendar end-time             Trigger 2: window watcher          Trigger 3: silence
//   ──────────────────────────────           ──────────────────────────         ──────────────────
//   At endTime: checkCalendarStop()          MeetingWindowWatcher: the          Every 30s:
//     if recDur < minRec → reschedule          meeting window closed →            if recDur < minRec
//     if sinceSpeech < 60s → reschedule        onWindowGone() (or a renderer        → return
//     else → triggerStop()                     track.ended hint)                  if silenceDur ≥
//                                              → floor: windowMinRecordingMs       silenceThr →
//                                                                                  triggerStop()
//                                    ▼  ▼  ▼
//                          triggerStop() ── idempotent via this.triggered
//                                    │
//                                    ▼
//                          onAutoStop() callback → sendToRenderer(RECORDING_AUTO_STOP)
//
// Two DIFFERENT floors gate stopping — do not unify them:
//   • minRecordingMs (5 min): guards calendar + silence triggers, protecting the
//     "click record, wait for a late participant" flow.
//   • windowMinRecordingMs (45 s): guards window-close only. Closing the meeting
//     window is a strong, intentional "I'm done" signal, so it needs no long
//     grace — the short floor just absorbs a transient enumeration glitch at t≈0.

const DEFAULT_SILENCE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes of silence
const DEFAULT_MIN_RECORDING_MS = 5 * 60 * 1000 // 5 minutes minimum recording
const DEFAULT_WINDOW_MIN_RECORDING_MS = 45 * 1000 // 45s floor for window-close
const CALENDAR_GRACE_MS = 0 // Check immediately at scheduled end time
const ACTIVE_SPEECH_THRESHOLD_MS = 60 * 1000 // Speech within last 1 min = still active
const SILENCE_CHECK_INTERVAL_MS = 30 * 1000 // 30 seconds

interface AutoStopOptions {
  onAutoStop: () => void
  calendarEndTime?: string // ISO string
  silenceThresholdMs?: number
  minRecordingMs?: number
  // Window-close detection (Trigger 2).
  meetingPlatform?: MeetingPlatform | null
  windowMinRecordingMs?: number
  // Injected for tests; the watcher falls back to the real desktopCapturer.
  getWindowSources?: () => Promise<WindowSource[]>
}

export class RecordingAutoStop {
  private calendarTimer: NodeJS.Timeout | null = null
  private windowWatcher: MeetingWindowWatcher | null = null
  private silenceChecker: NodeJS.Timeout | null = null
  private lastSpeechTime: number = Date.now()
  private recordingStartTime: number = Date.now()
  private triggered = false
  private stopped = false
  private onAutoStop: () => void
  private calendarEndTime: string | undefined
  private silenceThresholdMs: number
  private minRecordingMs: number
  private windowMinRecordingMs: number
  private meetingPlatform: MeetingPlatform | null
  private getWindowSources: (() => Promise<WindowSource[]>) | undefined

  constructor(options: AutoStopOptions) {
    this.onAutoStop = options.onAutoStop
    this.calendarEndTime = options.calendarEndTime
    this.silenceThresholdMs = options.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS
    this.minRecordingMs = options.minRecordingMs ?? DEFAULT_MIN_RECORDING_MS
    this.windowMinRecordingMs = options.windowMinRecordingMs ?? DEFAULT_WINDOW_MIN_RECORDING_MS
    this.meetingPlatform = options.meetingPlatform ?? null
    this.getWindowSources = options.getWindowSources
  }

  start(): void {
    this.recordingStartTime = Date.now()
    this.lastSpeechTime = Date.now()
    this.triggered = false
    this.stopped = false

    console.log('[AutoStop] Starting auto-stop detection')
    if (this.calendarEndTime) {
      const endTime = new Date(this.calendarEndTime)
      console.log(`[AutoStop] Calendar end time: ${endTime.toLocaleTimeString()}, grace period: ${CALENDAR_GRACE_MS / 60000} min`)
    }
    console.log(`[AutoStop] Silence threshold: ${this.silenceThresholdMs / 60000} min, min recording: ${this.minRecordingMs / 60000} min`)

    this.startCalendarTimer()
    this.startWindowWatcher()
    this.startSilenceChecker()
  }

  onSpeechDetected(): void {
    this.lastSpeechTime = Date.now()
  }

  /**
   * Single decision point for every "meeting window closed" signal — the
   * window-presence poll AND the renderer's track.ended hint both route here,
   * so the 45s floor and idempotency are enforced in one place.
   */
  onWindowGone(): void {
    if (this.triggered || this.stopped) return
    if (Date.now() - this.recordingStartTime < this.windowMinRecordingMs) {
      console.log('[AutoStop] Window closed but under window floor; ignoring')
      return
    }
    console.log('[AutoStop] Meeting window closed, stopping recording')
    this.triggerStop()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true

    if (this.calendarTimer) {
      clearTimeout(this.calendarTimer)
      this.calendarTimer = null
    }
    if (this.windowWatcher) {
      this.windowWatcher.stop()
      this.windowWatcher = null
    }
    if (this.silenceChecker) {
      clearInterval(this.silenceChecker)
      this.silenceChecker = null
    }
  }

  private triggerStop(): void {
    if (this.triggered) return
    this.triggered = true
    this.stop()
    this.onAutoStop()
  }

  private startCalendarTimer(): void {
    if (!this.calendarEndTime) return

    const endTime = new Date(this.calendarEndTime).getTime()
    if (isNaN(endTime)) return

    const msUntilEnd = endTime + CALENDAR_GRACE_MS - Date.now()
    if (msUntilEnd <= 0) {
      this.checkCalendarStop()
      return
    }

    this.calendarTimer = setTimeout(() => {
      this.checkCalendarStop()
    }, msUntilEnd)
  }

  private checkCalendarStop(): void {
    const sinceSpeech = Date.now() - this.lastSpeechTime
    const recordingDuration = Date.now() - this.recordingStartTime

    if (recordingDuration < this.minRecordingMs) {
      console.log('[AutoStop] Calendar end time reached but recording under min duration, extending')
      this.calendarTimer = setTimeout(() => {
        this.checkCalendarStop()
      }, 60 * 1000)
      return
    }
    if (sinceSpeech < ACTIVE_SPEECH_THRESHOLD_MS) {
      console.log('[AutoStop] Calendar end time reached but speech still active, extending')
      this.calendarTimer = setTimeout(() => {
        this.checkCalendarStop()
      }, 60 * 1000)
      return
    }
    console.log('[AutoStop] Calendar event end time + grace period reached, no recent speech')
    this.triggerStop()
  }

  /** Forward the renderer's captured-window track.ended hint (Signal B). */
  notifyWindowGone(): void {
    this.windowWatcher?.notifyTrackEnded()
  }

  private startWindowWatcher(): void {
    this.windowWatcher = new MeetingWindowWatcher({
      meetingPlatform: this.meetingPlatform,
      getWindowSources: this.getWindowSources,
      onGone: () => this.onWindowGone()
    })
    void this.windowWatcher.start()
  }

  private startSilenceChecker(): void {
    this.silenceChecker = setInterval(() => {
      const now = Date.now()
      const recordingDuration = now - this.recordingStartTime
      const silenceDuration = now - this.lastSpeechTime

      // Only trigger if recording has been running long enough
      if (recordingDuration < this.minRecordingMs) return

      // Log periodic status (every ~2 minutes when silence exceeds 1 minute)
      if (silenceDuration > 60000 && Math.floor(silenceDuration / 60000) % 2 === 0) {
        console.log(
          `[AutoStop] Silence check: ${Math.round(silenceDuration / 1000)}s since last speech (threshold: ${this.silenceThresholdMs / 1000}s)`
        )
      }

      if (silenceDuration >= this.silenceThresholdMs) {
        console.log(
          `[AutoStop] Silence threshold exceeded - no speech for ${Math.round(silenceDuration / 1000)}s, stopping recording`
        )
        this.triggerStop()
      }
    }, SILENCE_CHECK_INTERVAL_MS)
  }
}
