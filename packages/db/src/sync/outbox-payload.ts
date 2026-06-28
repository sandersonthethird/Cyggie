// =============================================================================
// outbox-payload.ts — single policy for serializing an owned-table row into the
// outbox `payload` JSON.
//
// WHY THIS EXISTS — the two-identity problem on the WRITE side:
//
//   The desktop knows the user by a LOCAL uuid (sync_state.user_id, minted
//   offline-first); the gateway knows the same user by its JWT `sub` (a cuid2).
//   They are the same person but live in different id-namespaces and are never
//   reconciled (see getMyUserIds() on the read side).
//
//   For owned tables the gateway STAMPS user_id from the JWT sub on push and
//   treats the payload's user_id as advisory. But if the payload CARRIES a
//   user_id that disagrees with the JWT sub, the gateway rejects it as a
//   cross-user-write attempt:
//
//       reason: `user_id mismatch (jwt=<cuid2> payload=<local-uuid>)`
//
//   Most owned tables have no SQLite user_id column, so their payload arrives
//   without one and the gateway just stamps it — no mismatch. A few tables
//   (company_flagged_files, attachments, contacts, org_companies, …) DO carry a
//   local user_id column, so the raw row would ship the local uuid and trip the
//   rejection. This helper drops that field; the gateway stamps the canonical
//   value either way.
//
//   The outbox.user_id COLUMN is NOT affected — only the serialized payload
//   field is dropped. The column stays the local id for local bookkeeping.
// =============================================================================

import type { OwnedTableSpec } from './owned-tables'

/**
 * Serialize `row` for the outbox `payload`, omitting `user_id` for tables whose
 * tenancy the gateway stamps from the JWT (`spec.hasUserId`). No-op for tables
 * without a local `user_id` column (the field simply isn't present).
 */
export function buildOutboxPayloadJson(
  spec: OwnedTableSpec,
  row: Record<string, unknown>,
): string {
  if (spec.hasUserId && 'user_id' in row) {
    const { user_id: _omit, ...rest } = row
    return JSON.stringify(rest)
  }
  return JSON.stringify(row)
}
