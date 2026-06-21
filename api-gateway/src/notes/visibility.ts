import { and, eq, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// =============================================================================
// Note visibility — THE single enforcement point for who may read a note.
//
// As the firm goes multi-user, notes are pooled as collective memory: a note
// *tagged* to a company or contact is visible to the whole firm by default,
// while the owner can keep any note private. The rule, in one place so every
// read path (GET /notes, GET /notes/:id, and — in Phase 2 — MCP + the AI/RAG
// context builder) shares one contract and a private note can never leak
// through a forgotten WHERE clause.
//
// A requester may see a note iff EITHER:
//   (a) they own it (notes.user_id = me) — any visibility, incl. private/untagged
//   (b) a same-firm teammate owns it AND it is tagged (company_id or contact_id)
//       AND it is not private (is_private = false)
//
//   ┌──────────────── firm guard (OUTER) ────────────────┐
//   │ users.firm_id = me.firm_id                          │   every returned row
//   │   AND ( notes.user_id = me            ← (a) own     │   is provably owned by
//   │      OR (tagged AND NOT is_private)   ← (b) shared )│   a same-firm user
//   └────────────────────────────────────────────────────┘
//
// USAGE: the calling query MUST inner-join `users` onto the note owner so the
// firm guard has a row to test:
//
//   db.select({ ... })
//     .from(schema.notes)
//     .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
//     .where(and(noteVisibilityFilter(user), ...otherFilters))
//
// The inner join doubles as the author-attribution source (users.display_name)
// — no extra join needed. firm_id is guaranteed non-null by requireFirm().
//
// V1 deliberately ships ONLY this SQL predicate — no single-row canViewNote()
// boolean, because every consumer is a query that applies the predicate
// directly and 404s on an empty result. A boolean mirror would be a second
// copy of the rule with nothing using it (DRY hazard). Add it in Phase 2 if
// AI/MCP need to check a note already in hand.
// =============================================================================

/** The minimal viewer identity the predicate needs (a superset of requireFirm()'s claims). */
export interface NoteViewer {
  sub: string
  firm_id: string
}

export interface NoteVisibilityOpts {
  /**
   * Include soft-deleted rows (deleted_at IS NOT NULL). Default false — every
   * READ path excludes them. The ONE exception is `/sync/pull`, which MUST send
   * soft-deleted rows so a delete (an UPDATE setting deleted_at) replicates to
   * teammates' devices; it passes `includeDeleted: true`. Keeping this in the
   * single visibility contract (rather than scattering `isNull(deletedAt)`
   * across every read site) preserves the "one place" guarantee in the header.
   */
  includeDeleted?: boolean
}

/**
 * WHERE predicate enforcing note visibility for `viewer`. Requires the query to
 * inner-join `schema.users` onto `schema.notes.userId` (see module header).
 *
 * By default it also excludes soft-deleted notes (`deleted_at IS NULL`) so no
 * read path leaks a deleted note. `/sync/pull` opts back in via
 * `{ includeDeleted: true }` (it needs the deleted row to replicate the delete).
 */
export function noteVisibilityFilter(
  viewer: NoteViewer,
  opts: NoteVisibilityOpts = {},
): SQL {
  const visibility = and(
    // OUTER firm guard — every row's owner must be in the viewer's firm.
    eq(schema.users.firmId, viewer.firm_id),
    or(
      // (a) own — any visibility, including private and untagged.
      eq(schema.notes.userId, viewer.sub),
      // (b) teammate's note that is tagged AND not private.
      and(
        or(
          isNotNull(schema.notes.companyId),
          isNotNull(schema.notes.contactId),
        ),
        eq(schema.notes.isPrivate, false),
      ),
    ),
  )
  return (
    opts.includeDeleted
      ? visibility
      : and(visibility, isNull(schema.notes.deletedAt))
  ) as SQL
}
