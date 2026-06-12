// =============================================================================
// notes-privacy-backfill.service.ts — one-shot historical privacy backfill.
//
// The private-notes feature shipped default-shared (is_private defaults false →
// any *tagged* note is firm-visible). This one-time pass marks every EXISTING
// note that has no company tagged (company_id IS NULL — untagged AND
// contact-only) as private, so only company-tagged notes stay firm-visible.
//
// `notes` is an owned, synced table: a plain UPDATE would never reach Neon. So,
// like custom-field-sync-backfill.service.ts, we mint a lamport, bump the row,
// and enqueue an outbox entry that the SyncAgent drains to Neon on /sync/push.
//
// Two deviations from the precedent services, both deliberate:
//   1. MINIMAL outbox payload `{ id, is_private: true, lamport }` — NOT the raw
//      SELECT * row. notes.is_pinned is a Postgres *boolean*, so a raw SQLite
//      integer flag would be rejected by the gateway validator; and shipping
//      only is_private avoids clobbering a note's content/title if it was
//      edited more recently on another device (op='update', not a full upsert).
//   2. A run-once guard in `settings` (notesPrivacyBackfillV1Done) so this stays
//      a historical operation and never re-privatizes notes created later.
//
// Idempotent two ways: the done-flag short-circuits re-runs, and the
// `is_private = 0` predicate skips already-flipped rows on a crash-resume.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { OWNED_TABLES_BY_NAME, type OwnedTableSpec } from '@cyggie/db/sync/owned-tables'
import { encodeRowId } from '@cyggie/db/sync/encode-row-id'
import { nextLamport } from '@cyggie/db/sync/sync-clock'

const DEVICE_ID_KEY = 'syncDeviceId'
const DONE_FLAG_KEY = 'notesPrivacyBackfillV1Done'

export interface NotesPrivacyBackfillResult {
  notesPrivatized: number
  skipped: number
  alreadyDone: boolean
}

/**
 * Flip every existing note with no company tag to is_private=1 and enqueue the
 * change to the outbox. Early-returns (without setting the done-flag) when
 * `userId` or the sync `deviceId` isn't available yet, so the next launch picks
 * the work back up.
 */
export function backfillNotesPrivacy(userId: string | null): NotesPrivacyBackfillResult {
  const empty: NotesPrivacyBackfillResult = { notesPrivatized: 0, skipped: 0, alreadyDone: false }
  if (!userId) {
    console.log('[notes-privacy-backfill] skipped: no user_id at launch')
    return empty
  }
  const db = getDatabase()

  const done = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DONE_FLAG_KEY) as { value: string } | undefined
  if (done?.value === '1') {
    return { notesPrivatized: 0, skipped: 0, alreadyDone: true }
  }

  const deviceIdRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DEVICE_ID_KEY) as { value: string } | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    console.log('[notes-privacy-backfill] skipped: device_id not yet provisioned')
    return empty
  }

  const noteSpec = OWNED_TABLES_BY_NAME.get('notes')
  if (!noteSpec) {
    console.error('[notes-privacy-backfill] OWNED_TABLES missing notes entry')
    return empty
  }

  // No company tagged → private (covers untagged + contact-only). is_private=0
  // skips rows already flipped (resume-idempotent).
  const rows = db
    .prepare("SELECT id FROM notes WHERE company_id IS NULL AND is_private = 0")
    .all() as Array<{ id: string }>

  let notesPrivatized = 0
  let skipped = 0
  for (const { id } of rows) {
    try {
      enqueueOne(db, deviceId, userId, noteSpec, id)
      notesPrivatized++
    } catch (err) {
      console.error(`[notes-privacy-backfill] failed note ${id}:`, err)
      skipped++
    }
  }

  // Mark done only after a full pass with no fatal error, so future untagged
  // notes are never re-privatized. (Per-row failures are tolerated — they retry
  // next launch because the flag isn't set when skipped > 0.)
  if (skipped === 0) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(DONE_FLAG_KEY)
  }

  console.log(`[notes-privacy-backfill] privatized=${notesPrivatized} skipped=${skipped}`)
  return { notesPrivatized, skipped, alreadyDone: false }
}

/**
 * One note, one transaction: mint a lamport, set is_private=1 + stamp the
 * lamport, enqueue a MINIMAL outbox 'update' (is_private as a JS boolean — the
 * notes Postgres column is boolean; never ship the raw is_pinned integer).
 */
function enqueueOne(
  db: import('better-sqlite3').Database,
  deviceId: string,
  userId: string,
  spec: OwnedTableSpec,
  id: string,
): void {
  const tx = db.transaction(() => {
    const lamport = nextLamport(db, deviceId)
    db.prepare('UPDATE notes SET is_private = 1, lamport = ? WHERE id = ?').run(lamport, id)

    const payload = { id, is_private: true, lamport }
    const rowId = encodeRowId(spec, { id })
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
       VALUES (?, ?, ?, ?, 'update', ?, ?)`,
    ).run(userId, deviceId, 'notes', rowId, JSON.stringify(payload), lamport)
  })
  tx()
}

/**
 * Fire-and-forget launcher. Defers 3.6s — just after the custom-field sync
 * backfill (3.5s) so it doesn't compete with the SyncAgent's first tick.
 */
export function backfillNotesPrivacyOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillNotesPrivacy(userId)
    } catch (err) {
      console.error('[notes-privacy-backfill] unexpected failure:', err)
    }
  }, 3600)
}
