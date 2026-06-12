import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RecordingAutoStop } from '../main/recording/auto-stop'

// RecordingAutoStop constructs a MeetingAudioWatcher (which imports electron +
// spawns a helper). Inject a no-op stub so tests never spawn anything.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/tmp' }
}))

const stubWatcher = () => ({ start: vi.fn(), stop: vi.fn() })

// Most calendar tests pass a tiny minRecordingMs so the min-duration gate
// doesn't block the behavior under test. Dedicated gate tests use the real
// default.
const TINY_MIN = 100

describe('RecordingAutoStop — calendar detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires checkCalendarStop at end time with no grace period', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN, audioWatcher: stubWatcher() })
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

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN, audioWatcher: stubWatcher() })
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

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN, audioWatcher: stubWatcher() })
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

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, minRecordingMs: TINY_MIN, audioWatcher: stubWatcher() })
    autoStop.start()
    autoStop.stop()

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onAutoStop).not.toHaveBeenCalled()
  })
})

describe('RecordingAutoStop — min-recording-duration gate (late participants)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, audioWatcher: stubWatcher() })
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

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime, audioWatcher: stubWatcher() })
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

describe('RecordingAutoStop — onMeetingEnded (mic released)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops immediately when the meeting ends (no floor — the watcher gates it)', () => {
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop, audioWatcher: stubWatcher() })
    autoStop.start()

    autoStop.onMeetingEnded()
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — repeated meeting-ended signals fire onAutoStop once', () => {
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop, audioWatcher: stubWatcher() })
    autoStop.start()

    autoStop.onMeetingEnded()
    autoStop.onMeetingEnded()
    autoStop.onMeetingEnded()
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })

  it('does nothing after stop()', () => {
    const onAutoStop = vi.fn()
    const watcher = stubWatcher()
    const autoStop = new RecordingAutoStop({ onAutoStop, audioWatcher: watcher })
    autoStop.start()
    autoStop.stop()

    autoStop.onMeetingEnded()
    expect(onAutoStop).not.toHaveBeenCalled()
    expect(watcher.stop).toHaveBeenCalled() // watcher torn down on stop()
  })

  it('starts and stops the injected audio watcher with the recording', () => {
    const onAutoStop = vi.fn()
    const watcher = stubWatcher()
    const autoStop = new RecordingAutoStop({ onAutoStop, audioWatcher: watcher })

    autoStop.start()
    expect(watcher.start).toHaveBeenCalledTimes(1)

    autoStop.stop()
    expect(watcher.stop).toHaveBeenCalledTimes(1)
  })
})
