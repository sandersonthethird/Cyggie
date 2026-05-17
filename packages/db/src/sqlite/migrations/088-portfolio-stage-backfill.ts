import type Database from 'better-sqlite3'

/**
 * One-time data repair: align pipeline_stage with entity_type for portfolio companies.
 *
 * Context: Before this migration, "Portfolio" was an entityType but not a pipeline
 * stage. Companies marked entityType='portfolio' typically had pipeline_stage stuck
 * at 'documentation' or null, which now reads as wrong now that 'portfolio' exists
 * as the success terminal of the pipeline.
 *
 * This sweep sets pipeline_stage='portfolio' for any company whose entity_type is
 * 'portfolio' but whose pipeline_stage isn't already 'portfolio' or 'pass'. The
 * 'pass' guard prevents clobbering a deliberate "we passed but they're now in a
 * different fund's portfolio" edge case.
 *
 * Idempotent — the WHERE clause stops matching after a successful run.
 */
export function runPortfolioStageBackfillMigration(db: Database.Database): void {
  const result = db
    .prepare(`
      UPDATE org_companies
      SET pipeline_stage = 'portfolio', updated_at = datetime('now')
      WHERE entity_type = 'portfolio'
        AND (pipeline_stage IS NULL OR pipeline_stage NOT IN ('portfolio', 'pass'))
    `)
    .run()

  if (result.changes > 0) {
    console.log(`[migration-088] Set pipeline_stage='portfolio' for ${result.changes} portfolio companies`)
  }
}
