import type Database from 'better-sqlite3'

/**
 * One-time data repair: set include_in_companies_view = 1 for any company
 * whose entity_type is not 'unknown' but whose flag is currently 0.
 *
 * Root cause: createCompany() defaulted include_in_companies_view to
 * (entityType === 'prospect'), so manually-added portfolio/vc_fund/lp/etc.
 * companies were silently excluded from the companies table view.
 *
 * The updateCompany() path already had the correct logic
 * (entityType !== 'unknown'), so this migration aligns existing rows.
 */
export function runRepairCompanyViewFlagMigration(db: Database.Database): void {
  const result = db
    .prepare(`
      UPDATE org_companies
      SET include_in_companies_view = 1, updated_at = datetime('now')
      WHERE entity_type != 'unknown'
        AND entity_type IS NOT NULL
        AND include_in_companies_view = 0
    `)
    .run()

  if (result.changes > 0) {
    console.log(`[migration-067] Fixed include_in_companies_view for ${result.changes} companies`)
  }
}
