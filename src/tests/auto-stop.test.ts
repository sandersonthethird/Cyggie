import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RecordingAutoStop } from '../main/recording/auto-stop'

// Mock process-detector so tests don't shell out to `ps aux`
vi.mock('../main/audio/process-detector', () => ({
  detectRunningMeetingApps: () => []
}))

describe('RecordingAutoStop — calendar detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires checkCalendarStop at end time with no grace period', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString() // fires in 100ms

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()

    // Advance to just before end time — should not have fired
    vi.advanceTimersByTime(50)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Advance past end time — checkCalendarStop fires.
    // Since recording just started, lastSpeechTime is ~now so sinceSpeech < 1min.
    // The check should reschedule for 1 min (not stop yet).
    vi.advanceTimersByTime(200)
    expect(onAutoStop).not.toHaveBeenCalled() // still active — speech within last 1min

    autoStop.stop()
  })

  it('stops after 1 minute of silence following meeting end time', () => {
    const onAutoStop = vi.fn()
    // End time 100ms from now
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()

    // Advance past end time — checkCalendarStop reschedules because speech was recent
    vi.advanceTimersByTime(200)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Advance 1 full minute (the reschedule interval) — silence threshold exceeded
    vi.advanceTimersByTime(60 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)

    autoStop.stop()
  })

  it('reschedules for another minute if speech detected within last 1 minute', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()

    // Advance past end time (first check — speech recent → reschedule)
    vi.advanceTimersByTime(200)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Simulate speech at 30s into the reschedule window
    vi.advanceTimersByTime(30 * 1000)
    autoStop.onSpeechDetected()

    // Advance to 60s — second check fires, but speech was 30s ago (< 1min) → reschedule again
    vi.advanceTimersByTime(30 * 1000 + 100)
    expect(onAutoStop).not.toHaveBeenCalled()

    // Now advance a full minute with no speech → stops
    vi.advanceTimersByTime(60 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)

    autoStop.stop()
  })

  it('handles recording started after meeting end time has already passed', () => {
    const onAutoStop = vi.fn()
    // End time was 5 minutes ago
    const endTime = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()

    // checkCalendarStop fires immediately (msUntilEnd <= 0)
    // lastSpeechTime was just set to Date.now() → sinceSpeech ≈ 0 < 1min → reschedule
    vi.advanceTimersByTime(0)
    expect(onAutoStop).not.toHaveBeenCalled()

    // After 1 minute of silence → should stop
    vi.advanceTimersByTime(60 * 1000 + 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)

    autoStop.stop()
  })

  it('does not trigger twice if stop() is called before timer fires', () => {
    const onAutoStop = vi.fn()
    const endTime = new Date(Date.now() + 100).toISOString()

    const autoStop = new RecordingAutoStop({ onAutoStop, calendarEndTime: endTime })
    autoStop.start()
    autoStop.stop() // manually stopped before timer fires

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onAutoStop).not.toHaveBeenCalled()
  })
})
