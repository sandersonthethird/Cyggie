import type { MeetingPlatform } from '../constants/meeting-apps'
import type { TranscriptSegment } from './recording'
import type { CompanyEntityType, CompanyPipelineStage } from './company'

// MeetingStatus state machine + Past-list visibility.
//
//   created by:
//     - meeting-notifier (toast fires for upcoming event)
//     - calendar reconcile (past-events backfill on fetch)
//     - MEETING_PREPARE IPC (user taps Prepare on upcoming badge)
//     - MEETING_CREATE_MANUAL (manual note flow)
//          │
//          ▼
//     ┌──────────┐  start recording   ┌───────────┐  finalize   ┌─────────────┐  summarize  ┌────────────┐
//     │ scheduled│ ─────────────────▶ │ recording │ ──────────▶ │ transcribed │ ──────────▶ │ summarized │
//     └──────────┘                    └───────────┘             └─────────────┘             └────────────┘
//                                          │
//                                          │ failure / orphaned recording  ┌───────┐
//                                          └─────────────────────────────▶ │ error │
//                                                                          └───────┘
//
//   Past-list visibility (after "i had a meeting" fix):
//     scheduled past   ✓  shown   (was hidden)
//     recording past   ✓  shown   (normally flipped to error on startup)
//     transcribed past ✓  shown
//     summarized past  ✓  shown
//     error past       ✓  shown   (was hidden)
//
//   Future-dated 'scheduled' rows are NOT shown in Past (date <= now filter).
export type MeetingStatus = 'scheduled' | 'recording' | 'transcribed' | 'summarized' | 'error'

export type MeetingBucket = 'all' | 'today' | 'upcoming' | 'past' | 'unreviewed'

export interface MeetingCompany {
  id: string
  name: string
  domain: string | null
  stage: CompanyPipelineStage | null
  entityType: CompanyEntityType | null
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface Meeting {
  id: string
  title: string
  date: string
  durationSeconds: number | null
  calendarEventId: string | null
  meetingPlatform: MeetingPlatform | null
  meetingUrl: string | null
  /**
   * Free-text location from the originating Google Calendar event. Google
   * auto-attaches a Meet link to most events, so meetingUrl alone can't tell
   * in-person from video — this is the signal. classifyLocation() in
   * @cyggie/shared interprets the overloaded field at display time.
   */
  location: string | null
  transcriptPath: string | null
  summaryPath: string | null
  /**
   * AI-generated meeting summary markdown. Dual-written by the desktop
   * summarizer alongside summaryPath so mobile can render it via
   * GET /meetings/:id (Item 2). Migration 099. Null when the meeting
   * hasn't been summarized yet, or for meetings that predate the
   * dual-write (no automatic backfill in single-firm beta).
   */
  summary: string | null
  recordingPath: string | null
  transcriptDriveId: string | null
  summaryDriveId: string | null
  notes: string | null
  transcriptSegments: TranscriptSegment[] | null
  templateId: string | null
  speakerCount: number
  speakerMap: Record<number, string>
  speakerContactMap: Record<number, string>  // speakerIndex → contactId; populated by getMeeting, empty in listMeetings
  attendees: string[] | null  // Calendar attendees (names/emails), EXCLUDES self
  attendeeEmails: string[] | null
  /**
   * Meeting owner's calendar-side display name. Populated at creation
   * from CalendarEvent.selfName (Google Calendar API marks one attendee
   * as `self`). Null for impromptu / non-calendar recordings or when the
   * users-table backfill couldn't resolve a name. The summarizer renders
   * this as "Attendees: <selfName> (meeting owner), ..." so the owner
   * appears alongside `attendees` without needing a runtime users lookup.
   * Migration 107.
   */
  selfName: string | null
  /**
   * Which live transcription provider produced this meeting's transcript:
   * 'deepgram' or 'assemblyai'. NULL for meetings finalized before the
   * 2026-05-28 picker rollout. Used for debugging and the eventual
   * post-launch "which provider produced better transcripts in
   * production?" analysis. Migration 111.
   */
  transcriptProvider: 'deepgram' | 'assemblyai' | null
  /**
   * Deepgram speaker index that belongs to the recording user. Drives
   * the me/them bubble view: render-time wrapper aligns segments with
   * this index on the right ("me"), all other indices on the left
   * ("them"). NULL for meetings finalized before migration 112 / before
   * the recording was successfully resolved. Migration 112.
   */
  meSpeakerIndex: number | null
  companies: string[] | null
  dismissedCompanies: string[] | null
  chatMessages: ChatMessage[] | null
  status: MeetingStatus
  // Group-event ingestion gate (migration 098). When isGroupEvent is true,
  // syncContactsFromAttendees + company link auto-creation are skipped for this
  // meeting; attendees remain visible but no CRM rows are seeded. isGroupEventUserSet
  // locks the value against calendar re-sync recomputes.
  isGroupEvent: boolean
  isGroupEventUserSet: boolean
  /** Phase 4 — owner-only privacy opt-out (firm-shared when false). */
  isPrivate?: boolean
  createdAt: string
  updatedAt: string
  company: MeetingCompany | null
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
  person?: string
  company?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
}

export interface CompanySuggestion {
  id?: string            // present when the company exists in org_companies
  name: string
  domain: string
  entityType?: CompanyEntityType | null
}

export interface ContentMatchPreview {
  entityType: 'meeting' | 'email' | 'note' | 'memo' | 'company' | 'contact'
  entityId: string
  title: string
  snippet: string
  route: string
  context?: string
}

export interface CategorizedSuggestions {
  people: string[]
  companies: CompanySuggestion[]
  contacts: { id: string; label: string; context?: string }[]
  meetings: { id: string; title: string }[]
  notes: { id: string; label: string; context?: string }[]
  contentMatches: ContentMatchPreview[]
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
  companies: CompanySuggestion[]
}
