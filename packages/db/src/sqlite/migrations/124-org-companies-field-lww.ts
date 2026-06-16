import type Database from 'better-sqlite3'

/**
 * Phase 1 multiplayer (field-LWW + soft-delete) columns on `org_companies`.
 *
 *   • field_lamports TEXT — JSON map (snake_case column → lamport) giving each
 *     column its own logical clock so the gateway / pull-apply can merge edits
 *     PER COLUMN instead of replacing the whole row. NULL until the first
 *     field-LWW write (then densified). See packages/db/src/sync/field-lww.ts.
 *   • deleted_at TEXT — soft-delete tombstone timestamp (ISO). A user "delete"
 *     becomes an UPDATE setting this; reads filter `deleted_at IS NULL`. Hard
 *     purge (admin) is a separate path. 30-day recovery window.
 *   • deleted_by_user_id TEXT — who soft-deleted it (attribution).
 *
 * The Postgres side carries the same columns (firm_id is denormalized there
 * too; on single-firm desktop SQLite firm_id is unneeded — pull scoping is
 * server-side). Idempotent via PRAGMA table_info checks.
 */
export function runOrgCompaniesFieldLwwMigration(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info('org_companies')`)
    .all() as { name: string }[]
  const has = (name: string): boolean => cols.some((c) => c.name === name)

  if (!has('field_lamports')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN field_lamports TEXT`)
  }
  if (!has('deleted_at')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN deleted_at TEXT`)
  }
  if (!has('deleted_by_user_id')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN deleted_by_user_id TEXT`)
  }
}
