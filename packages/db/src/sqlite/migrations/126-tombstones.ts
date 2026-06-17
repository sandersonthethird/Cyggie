import type Database from 'better-sqlite3'

/**
 * Phase 3 multiplayer — local id-keyed tombstone registry.
 *
 * Mirrors the Neon `tombstones` table (gateway-written on admin purge). The
 * desktop pull applies each tombstone by hard-deleting the local row, and
 * records it here so:
 *   • the pull-apply upserts can skip a row that arrives in the same page as
 *     its tombstone (out-of-order guard), and
 *   • a local re-create of a purged id is gated.
 *
 * firm_id is carried but not FK-constrained (desktop is single-firm). Idempotent.
 */
export function runTombstonesMigration(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tombstones'`)
    .get()
  if (exists) return

  db.exec(`
    CREATE TABLE tombstones (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      firm_id TEXT,
      purged_by_user_id TEXT,
      lamport TEXT NOT NULL DEFAULT '0',
      purged_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tombstones_lamport ON tombstones(CAST(lamport AS INTEGER));
  `)
}
