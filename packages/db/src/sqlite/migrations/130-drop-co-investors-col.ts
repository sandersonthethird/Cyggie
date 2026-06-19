import type Database from 'better-sqlite3'

/**
 * Drops the legacy `org_companies.co_investors` column. Co-investors now flow
 * through the synced `company_investors` join table (the desktop UI reads
 * `coInvestorsList` from it; the gateway JOINs it). The column was never written
 * by current desktop code and was 0/715 in Neon — fully dead, so the drop is
 * non-destructive.
 *
 * Idempotent via PRAGMA. The column carries no index/trigger/generated-column
 * dependency. SQLite ≥ 3.35 (bundled by better-sqlite3) supports DROP COLUMN.
 * Matching Neon drop: packages/db/migrations/0044_common_excalibur.sql.
 */
export function runDropCoInvestorsColumnMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  if (cols.some((c) => c.name === 'co_investors')) {
    db.exec(`ALTER TABLE org_companies DROP COLUMN co_investors`)
  }
}
