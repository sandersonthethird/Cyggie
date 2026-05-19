/**
 * Group-event ingestion gate threshold.
 *
 * A meeting with more attendee emails than this value auto-flags as a group
 * event, which skips `syncContactsFromAttendees` and meeting↔company link
 * creation (the attendee list still lives on the meeting row, just not in the
 * CRM). Mirrors the FUZZY_THRESHOLD = 0.88 hardcoded-tunable pattern in
 * contact.repo.ts. Hardcoded permanently; not surfaced in settings UI.
 */
export const GROUP_EVENT_ATTENDEE_THRESHOLD = 10
