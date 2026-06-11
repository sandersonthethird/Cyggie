import { describe, it, expect, vi } from 'vitest'

// window-detector imports desktopCapturer at module load; stub it (these tests
// exercise the pure title-matching functions, not the real enumeration).
vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() } }))

import {
  findMeetingWindow,
  detectMeetingWindowPlatforms,
  type WindowSource
} from '../main/audio/window-detector'

const src = (name: string): WindowSource => ({ id: name, name })

describe('findMeetingWindow', () => {
  it('returns null for the "other" platform', () => {
    expect(findMeetingWindow([src('Zoom Meeting')], 'other')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(findMeetingWindow([src('Slack'), src('Finder')], 'zoom')).toBeNull()
  })

  it('prefers the active Zoom meeting window over ancillary Zoom windows', () => {
    const sources = [src('Zoom — toolbar'), src('Zoom Meeting'), src('zoom.us')]
    expect(findMeetingWindow(sources, 'zoom')?.name).toBe('Zoom Meeting')
  })

  it('matches the renamed "Zoom Workplace" window', () => {
    expect(findMeetingWindow([src('Zoom Workplace')], 'zoom')?.name).toBe('Zoom Workplace')
  })

  it('matches Google Meet by either title pattern', () => {
    expect(findMeetingWindow([src('Google Meet — Google Chrome')], 'google_meet')).not.toBeNull()
    expect(findMeetingWindow([src('meet.google.com/abc-defg — Chrome')], 'google_meet')).not.toBeNull()
  })

  it('prefers a Teams call window over the main hub', () => {
    const sources = [src('Microsoft Teams'), src('Meeting with Acme | Microsoft Teams')]
    expect(findMeetingWindow(sources, 'teams')?.name).toBe('Meeting with Acme | Microsoft Teams')
  })

  it('falls back to the Teams hub when it is the only window', () => {
    expect(findMeetingWindow([src('Microsoft Teams')], 'teams')?.name).toBe('Microsoft Teams')
  })
})

describe('detectMeetingWindowPlatforms', () => {
  it('returns an empty set when window titles are blank (Screen Recording not granted)', () => {
    // Without permission, desktopCapturer returns sources with empty names.
    expect(detectMeetingWindowPlatforms([src(''), src('')]).size).toBe(0)
  })

  it('returns the correct subset for mixed windows', () => {
    const result = detectMeetingWindowPlatforms([
      src('Zoom Meeting'),
      src('Slack'),
      src('meet.google.com/xyz — Google Chrome')
    ])
    expect([...result].sort()).toEqual(['google_meet', 'zoom'])
  })

  it('detects all three platforms when all are present', () => {
    const result = detectMeetingWindowPlatforms([
      src('Zoom Meeting'),
      src('Standup | Microsoft Teams'),
      src('Google Meet')
    ])
    expect([...result].sort()).toEqual(['google_meet', 'teams', 'zoom'])
  })
})
