import type { MeetingPlatform } from '../constants/meeting-apps'

export interface CalendarEvent {
  id: string
  title: string
  startTime: string
  endTime: string
  selfName: string | null
  attendees: string[]
  attendeeEmails: string[]
  meetingUrl: string | null
  platform: MeetingPlatform | null
  description: string | null
  // Raw `location` from the Google Calendar event. Persisted onto the meeting
  // row so the In person / Call chip can be shown (Google auto-adds a Meet
  // link to most events, so meetingUrl alone can't signal in-person).
  location: string | null
}
