import { google } from 'googleapis'
import { getOAuth2Client, isCalendarConnected } from './google-auth'
import { detectMeetingLink } from './meeting-detector'
import type { CalendarEvent } from '../../shared/types/calendar'

/**
 * Fetch upcoming calendar events for the next N hours.
 * Parses each event for video conference links.
 */
export async function getUpcomingEvents(hoursAhead = 24): Promise<CalendarEvent[]> {
  if (!isCalendarConnected()) return []

  const auth = getOAuth2Client()
  if (!auth) return []

  const calendar = google.calendar({ version: 'v3', auth })

  const now = new Date()
  const later = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000)

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20
    })

    const items = response.data.items || []
    console.log('[Calendar] Fetched', items.length, 'events from Google Calendar')

    return items.map((item) => {
      const detected = detectMeetingLink({
        conferenceData: item.conferenceData as CalendarEventConferenceData,
        description: item.description,
        location: item.location,
        hangoutLink: item.hangoutLink
      })

      const selfAttendee = (item.attendees || []).find((a) => a.self)
      const selfName = selfAttendee?.displayName || selfAttendee?.email || null

      const attendees = (item.attendees || [])
        .filter((a) => !a.self)
        .map((a) => a.displayName || a.email || 'Unknown')

      return {
        id: item.id || '',
        title: item.summary || 'Untitled Event',
        startTime: item.start?.dateTime || item.start?.date || '',
        endTime: item.end?.dateTime || item.end?.date || '',
        selfName,
        attendees,
        meetingUrl: detected?.url || null,
        platform: detected?.platform || null,
        description: item.description || null
      }
    })
  } catch (err) {
    console.error('Failed to fetch calendar events:', err)
    return []
  }
}

/**
 * Find the calendar event closest to the current time.
 * Used for auto-suggesting a meeting title and mapping
 * attendees to speakers when recording starts.
 */
export async function getCurrentMeetingEvent(): Promise<CalendarEvent | null> {
  const events = await getUpcomingEvents(1)
  const now = Date.now()

  // Find events happening now or starting within the next 5 minutes
  for (const event of events) {
    const start = new Date(event.startTime).getTime()
    const end = new Date(event.endTime).getTime()
    const fiveMinFromNow = now + 5 * 60 * 1000

    // Event is currently happening or about to start
    if ((start <= now && end >= now) || (start > now && start <= fiveMinFromNow)) {
      return event
    }
  }

  return null
}

// Internal type for conferenceData parsing
interface CalendarEventConferenceData {
  entryPoints?: Array<{ entryPointType?: string; uri?: string }>
}
