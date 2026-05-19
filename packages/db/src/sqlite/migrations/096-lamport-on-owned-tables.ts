import type Database from 'better-sqlite3'

/**
 * Adds `lamport TEXT NOT NULL DEFAULT '0'` to every owned table tracked by
 * the desktop SyncAgent (Phase 1.5a).
 *
 * The lamport column is the row-level logical clock used by the gateway's
 * Last-Write-Wins conflict resolution. Each `writeWithSync` call bumps the
 * value to `max(persisted, Date.now())+1` and propagates the new value in
 * the outbox payload; the gateway compares against the Postgres-side lamport
 * before upserting.
 *
 * The Postgres schema already carries `lamport` on these tables (see
 * `packages/db/src/schema/*.ts`). This migration brings SQLite in line.
 *
 * Idempotent: each table is checked via PRAGMA before ALTERing. Safe to
 * re-run; safe to apply on a database that's already partially migrated
 * (some tables added, some not).
 *
 * Table list mirrors `packages/db/src/sync/owned-tables.ts`. When that
 * registry grows, this migration also needs to grow OR a follow-up
 * migration adds the column to the new tables. Keep the two in sync.
 */
export function runLamportOnOwnedTablesMigration(db: Database.Database): void {
  // Mirrors OWNED_TABLES from packages/db/src/sync/owned-tables.ts.
  // Hardcoded here (vs imported) because this migration file is consumed by
  // the SQLite connection bootstrap before the sync module is necessarily
  // resolvable — keeping migrations self-contained matches the pattern used
  // by 001-094.
  const ownedTables = [
    'templates',
    'themes',
    'pipeline_configs',
    'speakers',
    'pipeline_stages',
    'org_companies',
    'org_company_aliases',
    'contacts',
    'contact_emails',
    'meetings',
    'meeting_speakers',
    'meeting_company_links',
    'meeting_speaker_contact_links',
    'notes',
    'note_folders',
    'tasks',
    'chat_sessions',
    'chat_session_messages',
  ] as const

  for (const table of ownedTables) {
    // Some tables might not exist yet (e.g. if an earlier migration was
    // skipped or this DB is older than expected). Skip silently — the
    // SyncAgent's update_hook will only fire for tables that actually exist,
    // and the gateway never tries to upsert into a non-existent table.
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) as { name: string } | undefined
    if (!tableExists) continue

    const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as {
      name: string
    }[]
    const hasLamport = cols.some((c) => c.name === 'lamport')
    if (hasLamport) continue

    // SQLite doesn't allow adding a NOT NULL column with a non-constant
    // default in a single statement, but 'TEXT NOT NULL DEFAULT '0'' is a
    // constant default and is accepted.
    db.exec(`ALTER TABLE ${table} ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
  }
}
