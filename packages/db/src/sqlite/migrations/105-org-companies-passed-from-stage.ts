import type Database from 'better-sqlite3'

/**
 * Capture the pipeline stage a deal was in immediately before being moved to
 * Pass. The PipelineStepper renders this column in two ways:
 *   - When NULL (legacy passed rows): all dots gray under passedTrack opacity.
 *   - When set: dots 0..passedFromStage filled red, halo on the Pass dot —
 *     "we got to Diligence, then passed."
 *
 * Writes are gated by saveWithDecisionPrompt on the renderer: only set on
 * transition INTO 'pass', cleared (NULL) on re-open from 'pass'. Idempotent;
 * safe to re-run.
 */
export function runOrgCompaniesPassedFromStageMigration(
  db: Database.Database,
): void {
  const cols = db
    .prepare(`PRAGMA table_info('org_companies')`)
    .all() as { name: string }[]
  const has = (name: string): boolean => cols.some((c) => c.name === name)

  if (!has('passed_from_stage')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN passed_from_stage TEXT`)
  }
}
