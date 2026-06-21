import type Database from 'better-sqlite3'

/**
 * Soft-delete columns on `notes` (cross-device delete replication).
 *
 *   • deleted_at TEXT — soft-delete timestamp (ISO). A user "delete" becomes an
 *     UPDATE setting this (op:'update' in the sync wrapper, NOT a row delete) so
 *     the deletion replicates to every device via the normal owned-table pull.
 *     Reads filter `deleted_at IS NULL`.
 *   • deleted_by_user_id TEXT — who soft-deleted it (attribution).
 *
 * Mirrors org_companies (migration 124) / tasks (125). The Postgres side carries
 * the same columns. No new index (deferred — see TODOS.md "partial active-set
 * indexes"). Idempotent via PRAGMA table_info checks.
 */
export function runNotesSoftDeleteMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('notes')`).all() as { name: string }[]
  const has = (name: string): boolean => cols.some((c) => c.name === name)

  if (!has('deleted_at')) {
    db.exec(`ALTER TABLE notes ADD COLUMN deleted_at TEXT`)
  }
  if (!has('deleted_by_user_id')) {
    db.exec(`ALTER TABLE notes ADD COLUMN deleted_by_user_id TEXT`)
  }
}
