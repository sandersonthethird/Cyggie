// =============================================================================
// optimistic-meeting.ts — client-first impromptu meeting.
//
// Mobile mints the meeting id on-device so the meeting view can open INSTANTLY
// (no network round-trip) and work OFFLINE. The id is the single identity used
// end-to-end: optimistic cache → POST /meetings/impromptu → notes outbox →
// /recordings/upload {meetingId} → transcript. The gateway never re-mints it.
//
//   generateClientMeetingId()  → a gateway-valid id (^[a-z0-9]{1,32}$)
//   buildOptimisticMeeting()   → a full MeetingDetail to seed the TanStack
//                                cache before navigating, so the screen renders
//                                immediately and a 404 (offline / pre-create
//                                window) can't blank it.
// =============================================================================

import type { MeetingDetail } from '../api/meetings'

/**
 * Mint a client-side meeting id. We deliberately do NOT pull in
 * `@paralleldrive/cuid2` (not a mobile dependency; RN crypto bundling is
 * fragile) — the gateway only requires the cuid2 *charset* (`^[a-z0-9]{1,32}$`),
 * so a timestamp+random base36 id satisfies the contract. Collision risk is
 * nil at single-firm volume (mirrors generateClientRecordingId's rationale),
 * and the id is unique per (user, id) on the server regardless.
 */
export function generateClientMeetingId(): string {
  const ts = Date.now().toString(36)
  let rand = ''
  while (rand.length < 16) {
    rand += Math.random().toString(36).slice(2)
  }
  // lowercase alphanumeric only, capped at 32 chars
  return `${ts}${rand}`.replace(/[^a-z0-9]/g, '').slice(0, 32)
}

/**
 * Build the optimistic MeetingDetail seeded into the cache at record start.
 * status='recording' + wasImpromptu so the detail screen renders its
 * recording state; everything content-bearing is empty until edited/synced.
 */
export function buildOptimisticMeeting(input: {
  id: string
  title: string
  /** ISO; defaults to now. */
  date?: string
}): MeetingDetail {
  const nowIso = new Date().toISOString()
  return {
    id: input.id,
    title: input.title,
    date: input.date ?? nowIso,
    durationSeconds: null,
    status: 'recording',
    updatedAt: nowIso,
    lamport: '0',
    scheduledEndAt: null,
    calendarEventId: null,
    wasImpromptu: true,
    isGroupEvent: false,
    meetingPlatform: null,
    meetingUrl: null,
    location: null,
    notes: null,
    summary: null,
    speakerCount: 0,
    hasTranscript: false,
    transcriptSegments: [],
    linkedCompanies: [],
    linkedContacts: [],
    attendeeContacts: [],
  }
}
