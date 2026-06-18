import { and, eq, or, type SQL } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// =============================================================================
// Entity visibility — THE single enforcement point for who may read a
// firm-shared, privacy-opt-out row (contacts, meetings as of Phase 4).
//
// Rule (per the product decision "firm-shared with is_private opt-out"):
//   a requester may see a row iff EITHER
//     (a) they own it       (user_id = me)            — any visibility, incl. private
//     (b) it's firm-shared  (firm_id = me.firm AND is_private = false)
//
// Unlike notes (which gate on *tagged* + not-private and need a users JOIN for
// the firm guard), contacts/meetings carry a denormalized `firm_id`, so the firm
// guard is the row's own column — index-backed by {table}_visibility_idx, no JOIN
// (L3). Notes keeps its own rule; `noteVisibilityFilter` is re-exported here so
// every read path imports its visibility predicate from one module.
//
// USAGE (drizzle): `.where(and(entityVisibilityFilter('contacts', user), …))`.
// In the raw-SQL /sync/pull templates, interpolate it: `sql`${filter} AND …``.
// =============================================================================

export { noteVisibilityFilter, type NoteViewer } from '../notes/visibility'

/** Minimal viewer identity (superset of requireFirm()'s claims). */
export interface EntityViewer {
  sub: string
  firm_id: string
}

/** Tables this filter covers — firm_id-denormalized with an is_private opt-out. */
export type VisibilityTable = 'contacts' | 'meetings'

const TABLE = {
  contacts: schema.contacts,
  meetings: schema.meetings,
} as const

/**
 * WHERE predicate enforcing firm-shared + owner-aware privacy for `viewer`.
 * Self-contained (includes the firm_id guard) — AND it with the lamport/other
 * clauses; do NOT also add a separate firm_id filter.
 */
export function entityVisibilityFilter(table: VisibilityTable, viewer: EntityViewer): SQL {
  const t = TABLE[table]
  return and(
    eq(t.firmId, viewer.firm_id),
    or(
      eq(t.userId, viewer.sub), // (a) own — any visibility, incl. private
      eq(t.isPrivate, false), // (b) firm-shared, not private
    ),
  ) as SQL
}
