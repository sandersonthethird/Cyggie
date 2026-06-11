import type Database from 'better-sqlite3'

/**
 * Adds `lamport TEXT NOT NULL DEFAULT '0'` to `custom_field_definitions` so it
 * can join the sync engine. User-defined custom fields (and their values) were
 * desktop-only until now — declared "owned" but never actually wrapped/synced.
 *
 * Added to OWNED_TABLES + write-validators in the same change set; the barrel
 * now wraps create/update/deleteFieldDefinition with withSync. The Postgres
 * `custom_field_definitions` table already has lamport + user_id (see
 * schema/custom_fields.ts). Pre-existing rows are enqueued by
 * custom-field-sync-backfill.service.ts (the lamport='0' sentinel).
 *
 * Idempotent via PRAGMA table_info check.
 */
export function runCustomFieldDefinitionsSyncLamportMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('custom_field_definitions')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'lamport')) return
  db.exec(`ALTER TABLE custom_field_definitions ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
}
