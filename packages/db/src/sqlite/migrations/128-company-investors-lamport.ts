import type Database from 'better-sqlite3'

/**
 * Adds a `lamport` clock to `company_investors` so it can join the desktop↔Neon
 * sync (PR: reliable co-investors). The table is a firm-shared child of
 * org_companies and rides the parent's firm scope in the pull — same shape as
 * org_company_aliases. Whole-row LWW, so no field_lamports needed.
 *
 * Idempotent via PRAGMA. Existing rows default to '0'; a one-time
 * backfill-outbox pass mints real lamports so they propagate to Neon.
 */
export function runCompanyInvestorsLamportMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(company_investors)') as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'lamport')) {
    db.exec(`ALTER TABLE company_investors ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
  }
}
