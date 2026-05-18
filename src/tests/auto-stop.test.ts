import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RecordingAutoStop } from '../main/recording/auto-stop'
import type { DetectionResult } from '../main/audio/process-detector'

const detectMock = vi.fn<[], DetectionResult>(() => ({ apps: [], status: 'ok' }))
vi.mock('../main/audio/process-detector', () => ({
  detectRunningMeetingApps: () => detectMock()
}))

// Most calendar tests pass a tiny minRecordingMs so the min-duration gate
// doesn't block the behavior under test. Dedicated gate tests use the real
// default.
const TINY_MIN = 100

describe('RecordingAutoStop — calendar detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    detectMock.mockReset()
    detectMock.mockReturnValue({ apps: [], status: 'ok' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires checkCalendarStop at end time with no grace period', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN })
    autoStop.start()

    vi.advanceTimersByTime(50)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Past end time, but speech was just recorded (sinceSpeech < 1 min) → reschedule
    vi.advanceTimersByTime(200)
    expect(onAutoStop).not.toHaveBeenCalled()

    autoStop.stop()
  })

  it('stops after 1 minute of silence following meeting end time', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN })
    autoStop.start()

    vi.advanceTimersByTime(200)
    expect(onAutoStop).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)

    autoStop.stop()
  })

  it('reschedules for another minute if speech detected within last 1 minute', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN })
    autoStop.start()

    vi.advanceTimersByTime(200)
    expect(onAutoStop).not.toHaveBeenCalled()

    vi.advanceTimersByTime(30 * 1000)
    autoStop.onSpeechDetected()

    vi.advanceTimersByTime(30 * 1000 + 100)
    expect(onAutoStop).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)

    autoStop.stop()
  })

  it('does not trigger twice if stop() is called before timer fires', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN })
    autoStop.start()
    autoStop.stop()

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onAutoStop).not.toHaveBeenCalled()
  })
})

describe('RecordingAutoStop — min-recording-duration gate (late participants)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    detectMock.mockReset()
    detectMock.mockReturnValue({ apps: [], status: 'ok' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT auto-stop in the first 5 min even if endTime is in the past and there is no speech', () => {
    const onAutoStop = vi.fn()
    // Recording started 5 minutes after the meeting was supposed to end —
    // this is the "click record after the meeting started, waiting for late
    // participant" case.
    const endTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()

    // Immediately past endTime → checkCalendarStop fires → recDur < minRec → reschedule.
    vi.advanceTimersByTime(0)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Advance 4 minutes with no speech. recDur=4min, still < 5min → reschedule.
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(onAutoStop).not.toHaveBeenCalled()
  })

  it('does auto-stop once recording crosses minRec AND silence exceeds 60s past endTime', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()

    // First check at t=0: recDur < minRec → reschedule for 60s
    vi.advanceTimersByTime(0)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Advance enough time that recordingDuration > minRec on the next check.
    // Reschedule fires at t=60s, t=120s, t=180s, t=240s (each still < 5min minRec → reschedule).
    // At t=300s (5min): recDur = 300s >= 5min → gate passes; sinceSpeech = 300s >= 60s → stop.
    vi.advanceTimersByTime(5 * 60 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })
})

describe('RecordingAutoStop — process poller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    detectMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is inert when no meeting apps detected at start', () => {
    detectMock.mockReturnValue({ apps: [], status: 'ok' })
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop })
    autoStop.start()

    // Stay under silenceThresholdMs (10 min) so the silence checker doesn't
    // fire — we're isolating the poller's behavior.
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(onAutoStop).not.toHaveBeenCalled()
    // After the initial detection call, the poller short-circuits and never
    // starts setInterval — only the initial sync call should be visible.
    expect(detectMock).toHaveBeenCalledTimes(1)

    autoStop.stop()
  })

  it('does NOT stop in the first 5 min even if all initially-detected apps are gone', () => {
    detectMock
      .mockReturnValueOnce({ apps: [{ platform: 'teams', name: 'Microsoft Teams', pid: 1 }], status: 'ok' })
      .mockReturnValue({ apps: [], status: 'ok' }) // every subsequent poll: apps all gone
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop })
    autoStop.start()

    vi.advanceTimersByTime(4 * 60 * 1000) // 4 min — under 5 min minRec
    expect(onAutoStop).not.toHaveBeenCalled()

    autoStop.stop()
  })

  it('skips polls where detector returns status=error (transient ps flakes)', () => {
    detectMock
      .mockReturnValueOnce({ apps: [{ platform: 'teams', name: 'Microsoft Teams', pid: 1 }], status: 'ok' })
      .mockReturnValue({ apps: [], status: 'error' }) // every subsequent poll: ps errored
    const onAutoStop = vi.fn()
    // Stay well under the silence-stop threshold (10 min default) so an
    // unrelated silence-stop doesn't pollute the assertion.
    const autoStop = new RecordingAutoStop({ onAutoStop })
    autoStop.start()

    // Past minRec (5 min) so the gate isn't what's stopping us — but under
    // silenceThresholdMs (10 min).
    vi.advanceTimersByTime(6 * 60 * 1000)
    expect(onAutoStop).not.toHaveBeenCalled()
    // The poller is firing every 10s; with `status: 'error'` it should skip
    // each tick rather than acting on `apps: []`.
    expect(detectMock.mock.calls.length).toBeGreaterThan(30) // 6min / 10s = 36 polls + 1 initial

    autoStop.stop()
  })

  it('stops once recording crosses minRec AND all initially-detected apps are gone', () => {
    detectMock
      .mockReturnValueOnce({ apps: [{ platform: 'teams', name: 'Microsoft Teams', pid: 1 }], status: 'ok' })
      .mockReturnValue({ apps: [], status: 'ok' })
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop })
    autoStop.start()

    // Min recording is 5 min. Poll interval is 10s. First post-min poll fires at 5 min + 10s.
    vi.advanceTimersByTime(5 * 60 * 1000 + 10 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })
})
