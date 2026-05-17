import type Database from 'better-sqlite3'

/**
 * Rename legacy priority value `further_work` → `medium` on org_companies.
 *
 * Idempotent: re-runs are no-ops once no `further_work` rows remain.
 */
export function runPriorityRenameFurtherWorkMigration(db: Database.Database): void {
  db.prepare(`UPDATE org_companies SET priority = 'medium' WHERE priority = 'further_work'`).run()
}
