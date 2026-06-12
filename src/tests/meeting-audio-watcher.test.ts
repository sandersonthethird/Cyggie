import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// MeetingAudioWatcher imports electron `app` for the default helper path; stub
// it. Tests never call start(), so no helper process is spawned.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/tmp' }
}))

import { MeetingAudioWatcher } from '../main/recording/meeting-audio-watcher'

const make = (over: Partial<{ meetingPlatform: any; endDebounceMs: number }> = {}) => {
  const onMeetingEnded = vi.fn()
  const w = new MeetingAudioWatcher({
    onMeetingEnded,
    meetingPlatform: over.meetingPlatform ?? null,
    endDebounceMs: over.endDebounceMs ?? 100
  })
  return { w, onMeetingEnded }
}

describe('MeetingAudioWatcher.isMeetingActive', () => {
  it('matches the known app bundle id for a native platform', () => {
    expect(make({ meetingPlatform: 'zoom' }).w.isMeetingActive(['us.zoom.xos'])).toBe(true)
    expect(make({ meetingPlatform: 'zoom' }).w.isMeetingActive(['com.google.Chrome'])).toBe(false)
    expect(make({ meetingPlatform: 'teams' }).w.isMeetingActive(['com.microsoft.teams2'])).toBe(true)
  })

  it('matches any browser for Google Meet', () => {
    const { w } = make({ meetingPlatform: 'google_meet' })
    expect(w.isMeetingActive(['com.google.Chrome'])).toBe(true)
    expect(w.isMeetingActive(['com.apple.Safari'])).toBe(true)
    expect(w.isMeetingActive(['us.zoom.xos'])).toBe(false) // a native app isn't the Meet browser
  })

  it('with unknown platform, matches any known meeting app or browser', () => {
    const { w } = make({ meetingPlatform: null })
    expect(w.isMeetingActive(['us.zoom.xos'])).toBe(true)
    expect(w.isMeetingActive(['com.google.Chrome'])).toBe(true)
    expect(w.isMeetingActive(['com.apple.Finder'])).toBe(false)
    expect(w.isMeetingActive([])).toBe(false)
  })
})

describe('MeetingAudioWatcher.handleBundles (end detection)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onMeetingEnded after the meeting app was active then released the mic for the debounce', () => {
    const { w, onMeetingEnded } = make({ meetingPlatform: 'google_meet', endDebounceMs: 100 })
    w.handleBundles(['com.google.Chrome']) // in call
    w.handleBundles([]) // left call → mic released
    expect(onMeetingEnded).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120)
    expect(onMeetingEnded).toHaveBeenCalledTimes(1)
    w.stop()
  })

  it('does NOT fire if the meeting app was never active (e.g. joined early, recording before the call)', () => {
    const { w, onMeetingEnded } = make({ meetingPlatform: 'zoom', endDebounceMs: 100 })
    w.handleBundles([]) // nothing on the mic yet
    w.handleBundles(['com.apple.Finder']) // unrelated app
    vi.advanceTimersByTime(500)
    expect(onMeetingEnded).not.toHaveBeenCalled()
    w.stop()
  })

  it('cancels the pending end if the meeting app reacquires the mic within the debounce', () => {
    const { w, onMeetingEnded } = make({ meetingPlatform: 'zoom', endDebounceMs: 100 })
    w.handleBundles(['us.zoom.xos']) // active
    w.handleBundles([]) // released → schedule end
    vi.advanceTimersByTime(50) // ...but not yet fired
    w.handleBundles(['us.zoom.xos']) // reacquired → cancel
    vi.advanceTimersByTime(200)
    expect(onMeetingEnded).not.toHaveBeenCalled()
    w.stop()
  })

  it('ignores bundle updates after stop()', () => {
    const { w, onMeetingEnded } = make({ meetingPlatform: 'zoom', endDebounceMs: 100 })
    w.handleBundles(['us.zoom.xos'])
    w.stop()
    w.handleBundles([])
    vi.advanceTimersByTime(200)
    expect(onMeetingEnded).not.toHaveBeenCalled()
  })

  it('a muted-but-still-joined app keeps the mic, so no false stop', () => {
    // Muting in Meet/Zoom does not release the input device — the bundle stays
    // in the list, so isMeetingActive stays true and nothing schedules an end.
    const { w, onMeetingEnded } = make({ meetingPlatform: 'zoom', endDebounceMs: 100 })
    w.handleBundles(['us.zoom.xos'])
    w.handleBundles(['us.zoom.xos']) // still present while muted
    vi.advanceTimersByTime(500)
    expect(onMeetingEnded).not.toHaveBeenCalled()
    w.stop()
  })
})
