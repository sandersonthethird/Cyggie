import type Database from 'better-sqlite3'

/**
 * Creates the local-side outbox + sync_state tables on SQLite.
 *
 * Mirrors the shape of `packages/db/src/schema/sync.ts` (the Postgres
 * outbox / sync_state) but with SQLite-friendly types:
 *
 *   • `payload` is TEXT (containing JSON) instead of jsonb — same approach
 *     as `meetings.speaker_map` and other JSON-in-TEXT columns elsewhere in
 *     the schema.
 *   • `id` uses INTEGER PRIMARY KEY AUTOINCREMENT instead of Postgres SERIAL.
 *   • Timestamps use ISO TEXT (same convention as the rest of SQLite here).
 *   • `status` and `attempts` are SQLite-only additions per the plan review:
 *     after 5 ack failures from the gateway, a row gets promoted to
 *     status='dead' and is skipped by the drain loop (a dead-letter UI
 *     banner surfaces the count to the user).
 *
 * Idempotent: every CREATE TABLE / INDEX uses IF NOT EXISTS.
 */
export function runSyncOutboxStateMigration(db: Database.Database): void {
  // ── outbox ─────────────────────────────────────────────────────────────
  //
  // Populated by writeWithSync inside every owned-row mutation. SyncAgent
  // drains pending rows in batches of 200; once the gateway acks, the row
  // is DELETEd. Rows that 422 from the gateway transition through
  // failed → dead at attempts=5 and stay around for ops inspection.
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL,                          -- 'insert' | 'update' | 'delete'
      payload TEXT NOT NULL,                      -- JSON-encoded row state
      lamport TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'failed' | 'dead'
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS outbox_status_id_idx ON outbox(status, id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS outbox_table_row_idx ON outbox(table_name, row_id)`)

  // ── sync_state ─────────────────────────────────────────────────────────
  //
  // Singleton-per-device row. Used to persist the lamport clock across
  // process restarts and to track the high-water-mark of acked rows.
  // 1.5a only writes `last_pushed_lamport`; `last_pulled_lamport` and the
  // pull-side machinery land with 1.5b.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}
