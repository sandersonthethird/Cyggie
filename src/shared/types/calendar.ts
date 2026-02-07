import type { MeetingPlatform } from '../constants/meeting-apps'

export interface CalendarEvent {
  id: string
  title: string
  startTime: string
  endTime: string
  selfName: string | null
  attendees: string[]
  meetingUrl: string | null
  platform: MeetingPlatform | null
  description: string | null
}
