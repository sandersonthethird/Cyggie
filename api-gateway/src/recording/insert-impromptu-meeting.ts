// =============================================================================
// insert-impromptu-meeting.ts — the single source of truth for the impromptu
// meetings-row INSERT shape.
//
// The same row shape is inserted from THREE call sites, all in the recurring
// meeting-row sync-divergence area:
//
//   1. POST /recordings/upload         — fully impromptu upload (no calEventId,
//                                         no pre-created row): audio present.
//   2. POST /meetings/impromptu        — client pre-creates the row at record
//                                         start: NO audio yet.
//   3. POST /recordings/upload         — create-if-absent for a client-minted
//        {meetingId}                     id whose pre-create never landed
//                                         (offline): audio present.
//
//        ┌────────────── insertImpromptuMeeting ──────────────┐
//        │ id, userId, firmId, title, date  (always)          │
//        │ recordingPath?                   (upload paths)     │
//        │ status='recording', wasImpromptu=true              │
//        │ calendarEventId=null  (NULLs are distinct in the   │
//        │                        (user,calEventId) unique idx)│
//        │ selfName  ← deriveSelfNameFromUser (null on fail)   │
//        │ createdByUserId=userId, lamport defaults '0'        │
//        └────────────────────────────────────────────────────┘
//
// Centralizing it guarantees the three paths can't drift (e.g. one forgetting
// `selfName` or `wasImpromptu`), which is exactly the class of bug behind the
// recent divergence repairs.
// =============================================================================

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { schema } from '@cyggie/db'
import { deriveSelfNameFromUser } from '../llm/self-name'

export interface InsertImpromptuMeetingInput {
  /** Meeting id — server-minted (createId) for the FAB upload path, or the
   *  client-minted cuid for the pre-create / create-if-absent paths. */
  id: string
  userId: string
  /** Firm that owns the row. Stamped from the JWT by every caller (all of
   *  which use requireFirm()), denormalized so the entityVisibilityFilter
   *  firm-guard is index-backed without a JOIN. NON-NULL: a NULL firm_id makes
   *  the row invisible to its own owner (firm_id = viewer.firm_id never matches),
   *  which is the exact MEETING_NOT_FOUND bug this field closes. */
  firmId: string
  title: string
  /** Recorded-at timestamp (client clock when available, else now). */
  date: Date
  /** Present on the upload paths; omitted when pre-creating without audio. */
  recordingPath?: string | null
  /** Usually null (impromptu). The upload path passes a calEventId through
   *  when one was supplied but no scheduled row existed yet, so the new row
   *  still associates with the calendar event. `wasImpromptu` stays true
   *  either way (matches the prior /recordings/upload behavior). */
  calendarEventId?: string | null
}

/**
 * Insert one impromptu meeting row. `selfName` is derived here so callers
 * never have to remember it; a derive failure degrades to null rather than
 * failing the insert (the column is nullable, backfilled later by desktop).
 *
 * Throws the raw Postgres error on conflict (e.g. 23505 if `id` collides with
 * another user's row) — callers decide whether to recover or reject.
 */
export async function insertImpromptuMeeting(
  db: NodePgDatabase<typeof schema>,
  input: InsertImpromptuMeetingInput,
): Promise<void> {
  let selfName: string | null = null
  try {
    selfName = await deriveSelfNameFromUser(db, input.userId)
  } catch {
    // self_name is cosmetic + backfilled later; never fail the insert on it.
    selfName = null
  }
  await db.insert(schema.meetings).values({
    id: input.id,
    userId: input.userId,
    firmId: input.firmId,
    title: input.title,
    date: input.date,
    calendarEventId: input.calendarEventId ?? null,
    recordingPath: input.recordingPath ?? null,
    selfName,
    status: 'recording',
    wasImpromptu: true,
    createdByUserId: input.userId,
    // lamport defaults to '0' per schema
  })
}
