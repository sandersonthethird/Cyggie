import type Database from 'better-sqlite3'

/**
 * Adds `lamport TEXT NOT NULL DEFAULT '0'` to `custom_field_values` so it can
 * join the sync engine alongside its parent custom_field_definitions (migration
 * 119). The barrel now wraps setFieldValue / deleteFieldValue with withSync; the
 * Postgres table already has lamport + user_id (schema/custom_fields.ts).
 * Pre-existing rows are enqueued by custom-field-sync-backfill.service.ts.
 *
 * Idempotent via PRAGMA table_info check.
 */
export function runCustomFieldValuesSyncLamportMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('custom_field_values')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'lamport')) return
  db.exec(`ALTER TABLE custom_field_values ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
}
