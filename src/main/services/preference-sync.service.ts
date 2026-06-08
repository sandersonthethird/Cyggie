// =============================================================================
// preference-sync.service.ts — emit user_preferences rows to the sync outbox.
//
// user_preferences joined the sync engine for cross-surface chat settings
// (Part E): migration 115 added lamport; OWNED_TABLES + write-validators gained
// the table. `setPreference` writes raw SQL (ON CONFLICT DO UPDATE) and does NOT
// reset lamport, so changes don't auto-emit. This service bridges that:
//
//   • syncPreferenceChange(userId, key) — call AFTER setPreference. Re-stamps the
//     row's lamport and enqueues one outbox row, REGARDLESS of current lamport
//     (so edits to an already-synced pref re-sync).
//   • backfillPreferencesOnLaunch(userId) — enqueue any pref row still at
//     lamport='0' (pre-existing rows from before the table was owned).
//
// Bidirectional sync (Neon→desktop) is handled by the normal SyncAgent pull
// once the table is owned, so a value set on mobile reaches desktop too.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { OWNED_TABLES_BY_NAME, type OwnedTableSpec } from '@cyggie/db/sync/owned-tables'
import { encodeRowId } from '@cyggie/db/sync/encode-row-id'
import { nextLamport } from '@cyggie/db/sync/sync-clock'

const DEVICE_ID_KEY = 'syncDeviceId'

function deviceId(db: import('better-sqlite3').Database): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_ID_KEY) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function enqueue(
  db: import('better-sqlite3').Database,
  dev: string,
  userId: string,
  spec: OwnedTableSpec,
  row: Record<string, unknown>,
): void {
  const tx = db.transaction(() => {
    const lamport = nextLamport(db, dev)
    db.prepare(`UPDATE user_preferences SET lamport = ? WHERE key = ?`).run(lamport, row['key'])
    const stamped = { ...row, lamport }
    const rowId = encodeRowId(spec, stamped)
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, dev, 'user_preferences', rowId, 'insert', JSON.stringify(stamped), lamport)
  })
  tx()
}

/** Re-stamp + enqueue a single preference after it changes (any lamport). */
export function syncPreferenceChange(userId: string | null, key: string): void {
  if (!userId) return
  try {
    const db = getDatabase()
    const dev = deviceId(db)
    if (!dev) return
    const spec = OWNED_TABLES_BY_NAME.get('user_preferences')
    if (!spec) return
    const row = db.prepare('SELECT * FROM user_preferences WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined
    if (!row) return
    enqueue(db, dev, userId, spec, row)
  } catch (err) {
    console.error(`[preference-sync] failed to enqueue '${key}':`, err)
  }
}

/** Enqueue every preference row still at lamport='0' (one-time backfill). */
export function backfillPreferencesForSync(userId: string | null): number {
  if (!userId) return 0
  const db = getDatabase()
  const dev = deviceId(db)
  if (!dev) return 0
  const spec = OWNED_TABLES_BY_NAME.get('user_preferences')
  if (!spec) return 0
  const rows = db
    .prepare("SELECT * FROM user_preferences WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  let n = 0
  for (const row of rows) {
    try {
      enqueue(db, dev, userId, spec, row)
      n++
    } catch (err) {
      console.error(`[preference-sync] backfill failed for '${String(row['key'])}':`, err)
    }
  }
  if (n > 0) console.log(`[preference-sync] backfilled ${n} preference(s)`)
  return n
}

export function backfillPreferencesForSyncOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillPreferencesForSync(userId)
    } catch (err) {
      console.error('[preference-sync] unexpected launch failure:', err)
    }
  }, 3000)
}
