import type Database from 'better-sqlite3'

/**
 * Drops the dead `org_companies.co_investors` column.
 *
 * Co-investors became a first-class synced join table (`company_investors`) in
 * PR #42; this legacy JSONB/TEXT column is fully dead (0/715 in Neon, 0/730 on
 * the desktop pre-flight) and no production code reads it after this PR. There is
 * no index/view/trigger on the column, so the drop is clean (unlike migration 127,
 * which had to drop indexes first). SQLite ≥ 3.35 (bundled by better-sqlite3)
 * supports DROP COLUMN. Idempotent via PRAGMA so re-runs are cheap no-ops.
 *
 * Matching Neon drop: packages/db/migrations/0045_*.sql.
 */
export function runDropDeadCoInvestorsMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  if (cols.some((c) => c.name === 'co_investors')) {
    db.exec(`ALTER TABLE org_companies DROP COLUMN co_investors`)
  }
}
