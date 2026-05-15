/**
 * Tests for AudioCapture flow-status heartbeat (src/main/audio/capture.ts).
 *
 * The heartbeat lives in the main-process AudioCapture class. We exercise it
 * by driving _tickForTests() at controlled simulated times via vi.setSystemTime
 * instead of spinning a real setInterval.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AudioCapture, type AudioFlowStatus } from '../main/audio/capture'

describe('AudioCapture flow-status heartbeat', () => {
  let capture: AudioCapture
  let flowEvents: AudioFlowStatus[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T15:00:00.000Z'))
    capture = new AudioCapture()
    flowEvents = []
    capture.on('flow-status', (s: AudioFlowStatus) => flowEvents.push(s))
  })

  afterEach(() => {
    capture.stop()
    vi.useRealTimers()
  })

  it('does not emit stalled while chunks arrive within threshold', () => {
    capture.start()
    // Simulate audio chunks arriving every 1s for 12s.
    const buf = Buffer.alloc(800)
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(1000)
      capture.feedAudioFromRenderer(buf)
      capture._tickForTests()
    }
    expect(flowEvents.filter((e) => e.state === 'stalled')).toHaveLength(0)
  })

  it('emits stalled exactly once when no chunks arrive for > 8s', () => {
    capture.start()
    // Advance past STALL_THRESHOLD_MS without feeding chunks.
    vi.advanceTimersByTime(9000)
    capture._tickForTests()
    capture._tickForTests()
    capture._tickForTests()
    const stalls = flowEvents.filter((e) => e.state === 'stalled')
    expect(stalls).toHaveLength(1)
    expect(stalls[0].stalledForMs).toBeGreaterThanOrEqual(9000)
  })

  it('emits flowing when chunks resume after a stall', () => {
    capture.start()
    vi.advanceTimersByTime(9000)
    capture._tickForTests()
    expect(flowEvents.filter((e) => e.state === 'stalled')).toHaveLength(1)

    capture.feedAudioFromRenderer(Buffer.alloc(800))
    const resumed = flowEvents.filter((e) => e.state === 'flowing')
    expect(resumed).toHaveLength(1)
    expect(capture.getFlowState()).toBe('flowing')
  })

  it('does not emit stalled while paused', () => {
    capture.start()
    capture.pause()
    vi.advanceTimersByTime(15000)
    capture._tickForTests()
    expect(flowEvents.filter((e) => e.state === 'stalled')).toHaveLength(0)
  })

  it('does not emit stalled after stop()', () => {
    capture.start()
    capture.stop()
    vi.advanceTimersByTime(15000)
    capture._tickForTests()
    expect(flowEvents.filter((e) => e.state === 'stalled')).toHaveLength(0)
  })

  it('resume() resets the silence clock so a long pause does not immediately stall', () => {
    capture.start()
    capture.pause()
    vi.advanceTimersByTime(30000)
    capture.resume()
    capture._tickForTests()
    expect(flowEvents.filter((e) => e.state === 'stalled')).toHaveLength(0)
  })
})
