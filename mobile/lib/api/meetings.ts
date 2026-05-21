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
  wasImpromptu: boolean
  // Group-event ingestion gate. When true, no contacts/companies were seeded
  // from this meeting's attendee list. Mobile shows a read-only banner;
  // toggling lives on desktop until Phase 1.5 bidirectional sync ships.
  isGroupEvent: boolean
  meetingPlatform: string | null
  meetingUrl: string | null
  notes: string | null
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
