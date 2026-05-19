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
