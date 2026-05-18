import { describe, it, expect } from 'vitest'
import { detectMeetingLink } from '../main/calendar/meeting-detector'

describe('detectMeetingLink', () => {
  it('prefers hangoutLink for Google Meet', () => {
    const result = detectMeetingLink({
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    })
    expect(result).toEqual({ url: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet' })
  })

  it('picks a video entry point out of conferenceData', () => {
    const result = detectMeetingLink({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1-555-555-5555' },
          { entryPointType: 'video', uri: 'https://zoom.us/j/123456789' },
        ],
      },
    })
    expect(result?.platform).toBe('zoom')
    expect(result?.url).toBe('https://zoom.us/j/123456789')
  })

  it('extracts a bare Teams URL from the description text', () => {
    const result = detectMeetingLink({
      description: 'Click to join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
    })
    expect(result?.platform).toBe('teams')
  })

  it('unwraps Outlook safelinks-wrapped Teams URLs', () => {
    const wrapped =
      'https://nam06.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253ameeting_abc%2540thread.v2%2F0&data=05%7C01'
    const result = detectMeetingLink({ description: `Join the meeting: ${wrapped}` })
    expect(result?.platform).toBe('teams')
    expect(result?.url).toContain('teams.microsoft.com')
    expect(result?.url).not.toContain('safelinks')
  })

  it('falls through cleanly on a safelinks-shaped URL with no `url` param', () => {
    const malformed = 'https://nam06.safelinks.protection.outlook.com/?data=foo'
    // No other URL in the text — should return null without throwing
    const result = detectMeetingLink({ description: malformed })
    expect(result).toBeNull()
  })

  it('returns null when no recognized meeting link is in the event', () => {
    const result = detectMeetingLink({
      description: 'Lunch tomorrow at noon. https://example.com/menu',
      location: '123 Main St',
    })
    expect(result).toBeNull()
  })

  it('scans location text too when description has no link', () => {
    const result = detectMeetingLink({
      description: null,
      location: 'https://teams.microsoft.com/l/meetup-join/19%3aabc',
    })
    expect(result?.platform).toBe('teams')
  })
})
