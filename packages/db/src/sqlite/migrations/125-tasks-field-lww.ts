import type Database from 'better-sqlite3'

/**
 * Phase 2 multiplayer (tasks firm-shared + field-LWW). Brings the SQLite `tasks`
 * table up to the sync contract:
 *
 *   • lamport TEXT NOT NULL DEFAULT '0' — row-level logical clock. tasks was
 *     never live-synced, so (unlike other owned tables) it lacks this column.
 *   • field_lamports TEXT — per-column clocks (JSON map) for field-level merge.
 *   • deleted_at / deleted_by_user_id — soft-delete (mirrors org_companies).
 *
 * firm_id is NOT added on SQLite (desktop is single-firm; the gateway stamps
 * firm_id from the JWT and scopes the pull server-side). Idempotent via
 * PRAGMA table_info checks.
 */
export function runTasksFieldLwwMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('tasks')`).all() as { name: string }[]
  const has = (name: string): boolean => cols.some((c) => c.name === name)

  if (!has('lamport')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
  }
  if (!has('field_lamports')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN field_lamports TEXT`)
  }
  if (!has('deleted_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN deleted_at TEXT`)
  }
  if (!has('deleted_by_user_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN deleted_by_user_id TEXT`)
  }
}
