import { describe, it, expect } from 'vitest'
import { findMeetingWindow, type WindowSource } from '../main/audio/window-detector'

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

  it('matches an in-call "Meet - <code>" title', () => {
    expect(findMeetingWindow([src('Meet - abc-defg-hij')], 'google_meet')).not.toBeNull()
  })

  it('prefers a Teams call window over the main hub', () => {
    const sources = [src('Microsoft Teams'), src('Meeting with Acme | Microsoft Teams')]
    expect(findMeetingWindow(sources, 'teams')?.name).toBe('Meeting with Acme | Microsoft Teams')
  })

  it('falls back to the Teams hub when it is the only window', () => {
    expect(findMeetingWindow([src('Microsoft Teams')], 'teams')?.name).toBe('Microsoft Teams')
  })
})
