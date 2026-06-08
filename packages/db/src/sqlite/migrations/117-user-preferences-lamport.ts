import type Database from 'better-sqlite3'

/**
 * Adds `lamport TEXT NOT NULL DEFAULT '0'` to `user_preferences` so it can join
 * the sync engine (Part E). The per-company email-thread cap
 * (`emailThreadsPerCompany`) is stored here and must reach Neon so the gateway
 * chat context (mobile/web) honors a value set on desktop — and vice versa.
 *
 * Also added to OWNED_TABLES + write-validators in the same change set. The
 * Postgres `user_preferences` table already has lamport + a (user_id, key) PK
 * (see schema/settings.ts). Idempotent via PRAGMA table_info check.
 */
export function runUserPreferencesLamportMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('user_preferences')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'lamport')) return
  db.exec(`ALTER TABLE user_preferences ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
}
