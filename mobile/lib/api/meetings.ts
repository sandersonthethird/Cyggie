import { api } from './client'

// Typed client for /meetings/* gateway routes.

export interface TranscriptSegment {
  speaker: number
  speakerLabel: string | null
  text: string
  startTime: number
  endTime: number
}

export interface MeetingLinkedCompany {
  id: string
  name: string
}

export interface MeetingLinkedContact {
  id: string
  fullName: string
  title: string | null
  speakerIndex: number
}

export interface MeetingDetail {
  id: string
  title: string
  date: string
  durationSeconds: number | null
  status: string
  /** ISO timestamp of last server-side mutation. Used by use-transcribing-poll
   *  to age-filter status='error' (retryable only if updated_at < 30min ago). */
  updatedAt: string
  /** Monotonic lamport clock. Mobile snapshots this when starting an edit
   *  session and increments it for the outbox PATCH (Last-Write-Wins). */
  lamport: string
  /** Scheduled end time from the originating calendar event (migration 0015).
   *  Null on impromptu rows. Detail screen renders "X min scheduled"
   *  pre-recording from (scheduledEndAt - date). */
  scheduledEndAt: string | null
  /** Calendar event id (T5). Mobile uses this to wire the "Record" CTA
   *  on scheduled meetings so the resulting upload finds-or-updates
   *  this row instead of inserting an impromptu one. Null when there's
   *  no originating calendar event (Record-FAB-created impromptu). */
  calendarEventId: string | null
  wasImpromptu: boolean
  // Group-event ingestion gate. When true, no contacts/companies were seeded
  // from this meeting's attendee list. Mobile shows a read-only banner;
  // toggling lives on desktop until Phase 1.5 bidirectional sync ships.
  isGroupEvent: boolean
  meetingPlatform: string | null
  meetingUrl: string | null
  notes: string | null
  /**
   * AI-generated summary markdown (Item 2). Populated by the desktop
   * summarizer's dual-write — null until the meeting has been summarized
   * (or for pre-migration meetings that haven't been re-summarized yet).
   * Mobile renders this in the Summary tab when feature flag
   * EXPO_PUBLIC_FEATURE_SUMMARY_TAB === '1'.
   */
  summary: string | null
  attendees: string[] | null
  attendeeEmails: string[] | null
  speakerCount: number
  hasTranscript: boolean
  transcriptSegments: TranscriptSegment[]
  linkedCompanies: MeetingLinkedCompany[]
  linkedContacts: MeetingLinkedContact[]
}

export async function fetchMeeting(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MeetingDetail> {
  return api.get<MeetingDetail>(`/meetings/${encodeURIComponent(id)}`, {
    signal: opts.signal,
  })
}

/**
 * Hard-delete a meeting (user-scoped on the gateway). Used today by the
 * empty-transcript "Discard" action on the meeting detail screen; safe to
 * call for any meeting the user owns.
 */
export async function deleteMeeting(id: string): Promise<void> {
  await api.delete<{ ok: true }>(`/meetings/${encodeURIComponent(id)}`)
}

export interface PrepareMeetingFromCalendarEventInput {
  calendarEventId: string
  title: string
  startTime: string // ISO
  endTime?: string // ISO; omit for all-day or unknown
  attendees?: string[]
  attendeeEmails?: string[]
  meetingUrl?: string
  meetingPlatform?: string
}

/**
 * POST /meetings/from-calendar-event — idempotent find-or-create.
 *
 * Mobile calls this when the user taps a calendar event card. If the
 * gateway has a row for `(userId, calendarEventId)`, it returns the
 * existing detail (200); otherwise it inserts a `status='scheduled'`
 * row and returns that (201). Either way, the response is a full
 * MeetingDetail the caller can navigate into.
 */
export async function prepareMeetingFromCalendarEvent(
  input: PrepareMeetingFromCalendarEventInput,
  opts: { signal?: AbortSignal } = {},
): Promise<MeetingDetail> {
  return api.post<MeetingDetail, PrepareMeetingFromCalendarEventInput>(
    '/meetings/from-calendar-event',
    input,
    { signal: opts.signal },
  )
}

/**
 * PATCH /meetings/:id — notes update with Last-Write-Wins via lamport.
 *
 * Not called from screens directly — the NotesEditor enqueues into the
 * sync outbox, and the sync agent drains entries through `api.patch`
 * (matching this contract). This export exists so tests + the agent
 * can share a typed signature.
 */
export interface UpdateMeetingNotesInput {
  notes: string | null
  lamport: string
}

export async function updateMeetingNotes(
  id: string,
  input: UpdateMeetingNotesInput,
): Promise<MeetingDetail> {
  return api.patch<MeetingDetail, UpdateMeetingNotesInput>(
    `/meetings/${encodeURIComponent(id)}`,
    input,
  )
}

// =============================================================================
// Enhance — POST /meetings/:id/enhance.
//
// Server-side AI summary of the meeting transcript via a user-picked
// template. The gateway resolves the user's Anthropic key, calls Claude,
// writes the result to meetings.summary, bumps lamport, transitions
// status to 'summarized', and returns the summary.
//
// AbortSignal threading: caller (the meeting detail screen) mints a
// controller + a 45s timer to bound the worst case and to cancel on
// component unmount (Issue 4B/4C from the eng review).
// =============================================================================

export interface EnhanceMeetingInput {
  templateId: string
}

export interface EnhanceMeetingResult {
  summary: string
  lamport: string
  status: string
}

export async function enhanceMeeting(
  id: string,
  input: EnhanceMeetingInput,
  opts?: { signal?: AbortSignal },
): Promise<EnhanceMeetingResult> {
  return api.post<EnhanceMeetingResult, EnhanceMeetingInput>(
    `/meetings/${encodeURIComponent(id)}/enhance`,
    input,
    opts,
  )
}

// =============================================================================
// Templates — GET /templates. Source for the EnhanceModal picker.
// Cached by TanStack at the call-site with a 1hr staleTime since the
// list rarely changes.
// =============================================================================

export interface SummaryTemplate {
  id: string
  name: string
  description: string
}

export async function fetchTemplates(): Promise<SummaryTemplate[]> {
  const result = await api.get<{ templates: SummaryTemplate[] }>('/templates')
  return result.templates
}
