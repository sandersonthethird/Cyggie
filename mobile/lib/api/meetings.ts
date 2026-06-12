import { api, apiFetchRaw, ApiError } from './client'

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
  primaryDomain: string | null
}

export interface MeetingLinkedContact {
  id: string
  fullName: string
  title: string | null
  speakerIndex: number
}

export interface AttendeeContact {
  name: string
  email: string | null
  contactId: string | null
  contactFullName: string | null
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
  /**
   * Free-text location from the calendar event. classifyLocation() in
   * @cyggie/shared interprets it to pick the In person / Call / video chip
   * (Google auto-adds a Meet link to most events, so meetingUrl alone can't
   * tell in-person from video). Null on impromptu / pre-migration rows.
   */
  location: string | null
  notes: string | null
  /**
   * AI-generated summary markdown (Item 2). Populated by the desktop
   * summarizer's dual-write — null until the meeting has been summarized
   * (or for pre-migration meetings that haven't been re-summarized yet).
   * Mobile renders this in the Summary tab when feature flag
   * EXPO_PUBLIC_FEATURE_SUMMARY_TAB === '1'.
   */
  summary: string | null
  speakerCount: number
  hasTranscript: boolean
  transcriptSegments: TranscriptSegment[]
  linkedCompanies: MeetingLinkedCompany[]
  linkedContacts: MeetingLinkedContact[]
  attendeeContacts: AttendeeContact[]
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
 * T16 — Recent impromptu (no-cal-event) meetings for the current user.
 * Calendar tab's Past segment renders these in a "My Recordings" section.
 *
 * Gateway: `GET /meetings/impromptu?days=N` — server filters
 * `calendar_event_id IS NULL AND date >= now() - INTERVAL N DAY`,
 * orders DESC, caps at 20 rows. Server returns the full `MeetingDetail`
 * shape so taps can navigate into detail without a second round-trip.
 *
 * `days` must be in [1, 30]; default 7 matches the user-facing "last 7
 * days" copy. Out-of-range values yield a 400 from the gateway.
 */
export async function fetchImpromptuMeetings(
  opts: { days?: number; signal?: AbortSignal } = {},
): Promise<MeetingDetail[]> {
  const days = opts.days ?? 7
  const res = await api.get<{ meetings: MeetingDetail[] }>(
    `/meetings/impromptu?days=${days}`,
    { signal: opts.signal },
  )
  return res.meetings
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
  location?: string
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
// Mobile attendee + company editing (2026-05-24).
//
// Mirrors desktop's EntityPicker-driven "add/remove attendee" + "link/unlink
// company" flow. All four helpers mint lamport via the mobile sync clock
// so the gateway's LWW check sees a strictly-greater value than whatever
// the server has now. On 409 (a desktop write raced us) the caller gets
// the current MeetingDetail back via the existing ConflictError shape.
// =============================================================================

import { tick as tickLamport } from '../sync/clock'

/**
 * PATCH /meetings/:id with the full new attendee arrays. Mirrors the
 * desktop MEETING_UPDATE handler — gateway just stores the JSONB arrays,
 * does NOT run `syncContactsFromAttendees` (per the "no enrichment from
 * mobile" rule).
 *
 * Caller is responsible for splicing/appending the right entries first.
 * Arrays must be the same length; gateway validates and 400s if not.
 */
export async function updateMeetingAttendees(
  id: string,
  attendees: string[],
  attendeeEmails: string[],
): Promise<MeetingDetail> {
  return api.patch<
    MeetingDetail,
    { attendees: string[]; attendeeEmails: string[]; lamport: string }
  >(`/meetings/${encodeURIComponent(id)}`, {
    attendees,
    attendeeEmails,
    lamport: tickLamport(),
  })
}

/**
 * POST /meetings/:id/companies — link an existing company. Idempotent
 * (re-link returns 200 with current detail, no duplicate row). Writes
 * both meeting_company_links + the JSONB cache on meetings.companies.
 */
export async function linkCompanyToMeeting(
  meetingId: string,
  companyId: string,
): Promise<MeetingDetail> {
  return api.post<MeetingDetail, { companyId: string; lamport: string }>(
    `/meetings/${encodeURIComponent(meetingId)}/companies`,
    { companyId, lamport: tickLamport() },
  )
}

/**
 * DELETE /meetings/:id/companies/:companyId — unlink. Idempotent
 * (unlinking a not-linked company is a 200 no-op).
 */
export async function unlinkCompanyFromMeeting(
  meetingId: string,
  companyId: string,
): Promise<MeetingDetail> {
  // api.delete doesn't accept a body in the existing helper; use the
  // generic raw fetch shape via api.post pattern reversed. Simplest: a
  // manual fetch — but the existing api client doesn't have a
  // body-bearing DELETE. Inline an apiFetchRaw call instead.
  const lamport = tickLamport()
  const { status, body } = await apiFetchRaw<{ lamport: string }>(
    `/meetings/${encodeURIComponent(meetingId)}/companies/${encodeURIComponent(companyId)}`,
    { method: 'DELETE', body: { lamport } },
  )
  if (status === 200) return body as MeetingDetail
  throw new ApiError({
    status,
    code: `HTTP_${status}`,
    message: `DELETE /meetings/${meetingId}/companies/${companyId} failed`,
    details: body,
  })
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
