import { detectRunningMeetingApps, type RunningMeetingApp } from '../audio/process-detector'

const DEFAULT_SILENCE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes of silence
const DEFAULT_MIN_RECORDING_MS = 5 * 60 * 1000 // 5 minutes minimum recording
const CALENDAR_GRACE_MS = 5 * 60 * 1000 // 5 minutes after scheduled end
const PROCESS_POLL_INTERVAL_MS = 10 * 1000 // 10 seconds
const SILENCE_CHECK_INTERVAL_MS = 30 * 1000 // 30 seconds

interface AutoStopOptions {
  onAutoStop: () => void
  calendarEndTime?: string // ISO string
  silenceThresholdMs?: number
  minRecordingMs?: number
}

export class RecordingAutoStop {
  private calendarTimer: NodeJS.Timeout | null = null
  private processPoller: NodeJS.Timeout | null = null
  private silenceChecker: NodeJS.Timeout | null = null
  private lastSpeechTime: number = Date.now()
  private recordingStartTime: number = Date.now()
  private initialMeetingApps: RunningMeetingApp[] = []
  private triggered = false
  private stopped = false
  private onAutoStop: () => void
  private calendarEndTime: string | undefined
  private silenceThresholdMs: number
  private minRecordingMs: number

  constructor(options: AutoStopOptions) {
    this.onAutoStop = options.onAutoStop
    this.calendarEndTime = options.calendarEndTime
    this.silenceThresholdMs = options.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS
    this.minRecordingMs = options.minRecordingMs ?? DEFAULT_MIN_RECORDING_MS
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
    console.log(`[AutoStop] Silence threshold: ${this.silenceThresholdMs / 60000} min`)

    this.startCalendarTimer()
    this.startProcessPoller()
    this.startSilenceChecker()
  }

  onSpeechDetected(): void {
    this.lastSpeechTime = Date.now()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true

    if (this.calendarTimer) {
      clearTimeout(this.calendarTimer)
      this.calendarTimer = null
    }
    if (this.processPoller) {
      clearInterval(this.processPoller)
      this.processPoller = null
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
      // Calendar event already ended (past grace period) — trigger immediately
      this.triggerStop()
      return
    }

    this.calendarTimer = setTimeout(() => {
      console.log('[AutoStop] Calendar event end time + grace period reached')
      this.triggerStop()
    }, msUntilEnd)
  }

  private startProcessPoller(): void {
    this.initialMeetingApps = detectRunningMeetingApps()
    if (this.initialMeetingApps.length === 0) return

    console.log(
      '[AutoStop] Detected meeting apps:',
      this.initialMeetingApps.map((a) => a.name).join(', ')
    )

    this.processPoller = setInterval(() => {
      const currentApps = detectRunningMeetingApps()
      const currentPlatforms = new Set(currentApps.map((a) => a.platform))

      // Check if ALL initially-detected meeting app platforms have exited
      const allExited = this.initialMeetingApps.every(
        (app) => !currentPlatforms.has(app.platform)
      )

      if (allExited) {
        console.log('[AutoStop] All initially-detected meeting apps have exited')
        this.triggerStop()
      }
    }, PROCESS_POLL_INTERVAL_MS)
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
