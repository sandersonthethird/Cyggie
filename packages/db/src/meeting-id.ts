// meeting-id.ts — deterministic id for calendar-sourced meetings.
//
// THE PROBLEM THIS SOLVES
// Desktop and the gateway independently create a `meetings` row for the same
// Google Calendar event:
//   • desktop  → uuidv4()   (meeting.repo.ts createMeeting)
//   • gateway  → createId() (from-calendar-event)
// Postgres UNIQUE(user_id, calendar_event_id) + SQLite UNIQUE(calendar_event_id)
// allow only ONE row per event, but the two sides pick DIFFERENT ids, so they
// never converge: desktop's push 23505s forever and the mobile-recorded
// transcript can't land on the row the user opens.
//
// THE FIX
// Derive the id deterministically from (userId, calendarEventId) so BOTH sides
// compute the SAME id for the same event. Then desktop's push lands via
// ON CONFLICT(id) instead of conflicting, and divergence never forms.
//
//   deriveCalendarMeetingId(u, e)  ──sha256──►  'cal_' + 24 hex chars
//        (same on Node gateway + Electron main — both have node:crypto)
//
// Must be byte-identical across runtimes — do NOT inline/duplicate this logic.
// Lives in @cyggie/db (not @cyggie/shared) precisely because it uses
// node:crypto: @cyggie/shared is bundled into the mobile RN app, which has no
// node:crypto; @cyggie/db is imported only by the gateway and desktop main
// process (both Node). Impromptu / Record-FAB meetings have no calendar event
// and keep a random uuid.

import { createHash } from 'node:crypto'

/**
 * Deterministic `meetings.id` for a calendar-sourced meeting. Identical output
 * on the gateway and desktop for the same (userId, calendarEventId), so the
 * row converges instead of diverging. The `cal_` prefix makes calendar-origin
 * rows greppable in logs/DB and visually distinct from uuid/cuid ids.
 */
export function deriveCalendarMeetingId(userId: string, calendarEventId: string): string {
  const hash = createHash('sha256').update(`${userId}|${calendarEventId}`).digest('hex')
  return `cal_${hash.slice(0, 24)}`
}
