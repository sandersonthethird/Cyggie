import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RecordingAutoStop } from '../main/recording/auto-stop'
import type { WindowSource } from '../main/audio/window-detector'

// The MeetingWindowWatcher (via window-detector) imports desktopCapturer; stub
// it so the watcher is inert by default (returns no windows). Window-close
// tests inject getWindowSources directly for determinism.
vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(async () => [] as WindowSource[]) }
}))

const src = (name: string): WindowSource => ({ id: name, name })
const noWindows = async (): Promise<WindowSource[]> => []

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

describe('RecordingAutoStop — onWindowGone chokepoint (floor + idempotency)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores a window-gone signal under the 45s window floor', () => {
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop, getWindowSources: noWindows })
    autoStop.start()

    autoStop.onWindowGone() // t≈0, default windowMinRecordingMs = 45s
    vi.advanceTimersByTime(30 * 1000)
    autoStop.onWindowGone()
    expect(onAutoStop).not.toHaveBeenCalled()

    autoStop.stop()
  })

  it('stops once the window-gone signal arrives past the floor', () => {
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({ onAutoStop, getWindowSources: noWindows })
    autoStop.start()

    vi.advanceTimersByTime(45 * 1000 + 100)
    autoStop.onWindowGone()
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — repeated window-gone signals fire onAutoStop once', () => {
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({
      onAutoStop,
      windowMinRecordingMs: TINY_MIN,
      getWindowSources: noWindows
    })
    autoStop.start()

    vi.advanceTimersByTime(TINY_MIN + 50)
    autoStop.onWindowGone()
    autoStop.onWindowGone()
    autoStop.onWindowGone()
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })

  it('does nothing after stop()', () => {
    const onAutoStop = vi.fn()
    const autoStop = new RecordingAutoStop({
      onAutoStop,
      windowMinRecordingMs: TINY_MIN,
      getWindowSources: noWindows
    })
    autoStop.start()
    autoStop.stop()

    vi.advanceTimersByTime(TINY_MIN + 50)
    autoStop.onWindowGone()
    expect(onAutoStop).not.toHaveBeenCalled()
  })
})

describe('RecordingAutoStop — window watcher integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops when the watched meeting window closes past the floor', async () => {
    const onAutoStop = vi.fn()
    const getWindowSources = vi
      .fn<[], Promise<WindowSource[]>>()
      .mockResolvedValueOnce([src('Zoom Meeting')]) // start snapshot → arm zoom
      .mockResolvedValue([src('Finder')]) // window closed
    const autoStop = new RecordingAutoStop({
      onAutoStop,
      meetingPlatform: 'zoom',
      windowMinRecordingMs: TINY_MIN,
      getWindowSources
    })
    autoStop.start()

    await vi.advanceTimersByTimeAsync(TINY_MIN + 750 * 3)
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })

  it('does not stop while the meeting window stays open', async () => {
    const onAutoStop = vi.fn()
    const getWindowSources = vi.fn(async () => [src('Zoom Meeting')])
    const autoStop = new RecordingAutoStop({
      onAutoStop,
      meetingPlatform: 'zoom',
      windowMinRecordingMs: TINY_MIN,
      getWindowSources
    })
    autoStop.start()

    await vi.advanceTimersByTimeAsync(TINY_MIN + 750 * 5)
    expect(onAutoStop).not.toHaveBeenCalled()
    autoStop.stop()
  })

  it('forwards a track.ended hint through onWindowGone (past floor)', async () => {
    const onAutoStop = vi.fn()
    const getWindowSources = vi.fn(async () => [src('Zoom Meeting')])
    const autoStop = new RecordingAutoStop({
      onAutoStop,
      meetingPlatform: 'zoom',
      windowMinRecordingMs: TINY_MIN,
      getWindowSources
    })
    autoStop.start()
    await vi.advanceTimersByTimeAsync(0) // let the start() snapshot resolve

    vi.advanceTimersByTime(TINY_MIN + 50)
    autoStop.notifyWindowGone()
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })
})
