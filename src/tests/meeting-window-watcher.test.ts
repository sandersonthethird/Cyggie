import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() } }))

import { MeetingWindowWatcher } from '../main/recording/meeting-window-watcher'
import type { WindowSource } from '../main/audio/window-detector'

const src = (name: string): WindowSource => ({ id: name, name })
const ZOOM = [src('Zoom Meeting')]
const TEAMS = [src('Standup | Microsoft Teams')]
const NONE: WindowSource[] = [src('Finder')]

describe('MeetingWindowWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is inert when no meeting window is present at start', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi.fn(async () => NONE)
    const w = new MeetingWindowWatcher({ onGone, getWindowSources, pollIntervalMs: 50 })
    await w.start()

    await vi.advanceTimersByTimeAsync(500)
    expect(onGone).not.toHaveBeenCalled()
    // Only the start() snapshot ran; no poll interval was armed.
    expect(getWindowSources).toHaveBeenCalledTimes(1)
    w.stop()
  })

  it('fires onGone after the watched platform is absent for the debounce count', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi
      .fn<[], Promise<WindowSource[]>>()
      .mockResolvedValueOnce(ZOOM) // start snapshot → arm zoom
      .mockResolvedValue(NONE) // every poll → gone
    const w = new MeetingWindowWatcher({
      meetingPlatform: 'zoom',
      onGone,
      getWindowSources,
      pollIntervalMs: 50,
      absenceDebounce: 2
    })
    await w.start()

    await vi.advanceTimersByTimeAsync(50) // 1st absent poll — under debounce
    expect(onGone).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50) // 2nd absent poll — fires
    expect(onGone).toHaveBeenCalled()
    w.stop()
  })

  it('watches every window present at start when platform is null', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi
      .fn<[], Promise<WindowSource[]>>()
      .mockResolvedValueOnce(TEAMS)
      .mockResolvedValue(NONE)
    const w = new MeetingWindowWatcher({
      meetingPlatform: null,
      onGone,
      getWindowSources,
      pollIntervalMs: 50,
      absenceDebounce: 1
    })
    await w.start()

    await vi.advanceTimersByTimeAsync(50)
    expect(onGone).toHaveBeenCalled()
    w.stop()
  })

  it('resets the debounce when the window reappears (tab switch / glitch)', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi
      .fn<[], Promise<WindowSource[]>>()
      .mockResolvedValueOnce(ZOOM) // start
      .mockResolvedValueOnce(NONE) // absent #1
      .mockResolvedValueOnce(ZOOM) // reappeared → reset
      .mockResolvedValue(NONE) // absent again
    const w = new MeetingWindowWatcher({
      meetingPlatform: 'zoom',
      onGone,
      getWindowSources,
      pollIntervalMs: 50,
      absenceDebounce: 2
    })
    await w.start()

    await vi.advanceTimersByTimeAsync(50) // absent #1
    await vi.advanceTimersByTimeAsync(50) // reappeared → reset
    expect(onGone).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50) // absent (count 1)
    expect(onGone).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50) // absent (count 2) → fire
    expect(onGone).toHaveBeenCalled()
    w.stop()
  })

  it('treats a failed enumeration tick as not-gone (no false fire)', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi
      .fn<[], Promise<WindowSource[]>>()
      .mockResolvedValueOnce(ZOOM) // start
      .mockRejectedValue(new Error('enumeration flake'))
    const w = new MeetingWindowWatcher({
      meetingPlatform: 'zoom',
      onGone,
      getWindowSources,
      pollIntervalMs: 50,
      absenceDebounce: 1
    })
    await w.start()

    await vi.advanceTimersByTimeAsync(200)
    expect(onGone).not.toHaveBeenCalled()
    w.stop()
  })

  it('stays inert if the start snapshot enumeration throws', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi.fn(async () => {
      throw new Error('no permission yet')
    })
    const w = new MeetingWindowWatcher({ onGone, getWindowSources, pollIntervalMs: 50 })
    await w.start()

    await vi.advanceTimersByTimeAsync(200)
    expect(onGone).not.toHaveBeenCalled()
    w.stop()
  })

  it('notifyTrackEnded reports gone immediately (Signal B)', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi.fn(async () => ZOOM)
    const w = new MeetingWindowWatcher({ meetingPlatform: 'zoom', onGone, getWindowSources })
    await w.start()

    w.notifyTrackEnded()
    expect(onGone).toHaveBeenCalledTimes(1)
    w.stop()
  })

  it('stop() halts polling', async () => {
    const onGone = vi.fn()
    const getWindowSources = vi
      .fn<[], Promise<WindowSource[]>>()
      .mockResolvedValueOnce(ZOOM)
      .mockResolvedValue(NONE)
    const w = new MeetingWindowWatcher({
      meetingPlatform: 'zoom',
      onGone,
      getWindowSources,
      pollIntervalMs: 50,
      absenceDebounce: 1
    })
    await w.start()
    w.stop()

    const callsAfterStop = getWindowSources.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(onGone).not.toHaveBeenCalled()
    expect(getWindowSources).toHaveBeenCalledTimes(callsAfterStop) // no further polls
  })
})
