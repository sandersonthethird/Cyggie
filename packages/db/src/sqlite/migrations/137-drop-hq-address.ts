import type Database from 'better-sqlite3'

/**
 * Drops the dead `org_companies.hq_address` column.
 *
 * `hq_address` was never adopted — 0/736 companies populate it; `city`/`state`
 * cover company location and are the fields actually used. No index/view/trigger
 * references it, so the drop is clean. SQLite ≥ 3.35 (bundled by better-sqlite3)
 * supports DROP COLUMN. Idempotent via PRAGMA so re-runs are cheap no-ops.
 *
 * Neon side is DEFERRED (see TODOS): the Drizzle schema drop (companies.ts) will
 * produce the Postgres `ALTER TABLE org_companies DROP COLUMN hq_address` on the next
 * `drizzle-kit generate`; apply it to Neon only after desktop builds with this migration
 * converge, to avoid sync-watermark drift — same staging as the co_investors drop (131).
 */
export function runDropHqAddressMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  if (cols.some((c) => c.name === 'hq_address')) {
    db.exec(`ALTER TABLE org_companies DROP COLUMN hq_address`)
  }
}
