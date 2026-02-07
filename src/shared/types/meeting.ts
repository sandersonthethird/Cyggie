import type { MeetingPlatform } from '../constants/meeting-apps'
import type { TranscriptSegment } from './recording'

export type MeetingStatus = 'scheduled' | 'recording' | 'transcribed' | 'summarized' | 'error'

export interface Meeting {
  id: string
  title: string
  date: string
  durationSeconds: number | null
  calendarEventId: string | null
  meetingPlatform: MeetingPlatform | null
  meetingUrl: string | null
  transcriptPath: string | null
  summaryPath: string | null
  transcriptDriveId: string | null
  summaryDriveId: string | null
  notes: string | null
  transcriptSegments: TranscriptSegment[] | null
  templateId: string | null
  speakerCount: number
  speakerMap: Record<number, string>
  attendees: string[] | null  // Calendar attendees (names/emails)
  status: MeetingStatus
  createdAt: string
  updatedAt: string
}

export interface MeetingListFilter {
  searchQuery?: string
  dateFrom?: string
  dateTo?: string
  platform?: MeetingPlatform
  status?: MeetingStatus
  templateId?: string
  limit?: number
  offset?: number
}

export interface SearchResult {
  meetingId: string
  title: string
  date: string
  snippet: string
  rank: number
}

export interface AdvancedSearchParams {
  query?: string
  speakers?: string[]
  dateFrom?: string
  dateTo?: string
  limit?: number
}

export interface AdvancedSearchResult {
  meetingId: string
  title: string
  date: string
  snippet: string
  rank: number
  speakerMap: Record<number, string>
  durationSeconds: number | null
  status: MeetingStatus
}
