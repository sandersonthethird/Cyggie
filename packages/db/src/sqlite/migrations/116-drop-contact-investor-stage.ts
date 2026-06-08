import type Database from 'better-sqlite3'

/**
 * Hard-drops the legacy `contacts.investor_stage` column. It was superseded by
 * investment_stage_focus (the "Target Investment Stage" multi-select, see
 * migration 115) and held zero data, so the drop is non-destructive.
 *
 * Idempotent via a PRAGMA existence check (no settings guard needed — the check
 * is self-describing and re-runs cheaply). SQLite ≥ 3.35 supports DROP COLUMN;
 * better-sqlite3 bundles a far newer engine. The column carries no index,
 * trigger, view, or generated-column dependency, so the drop is unconditional.
 *
 * The matching Neon drop ships in packages/db/migrations/0034_drop_contact_investor_stage.sql.
 */
export function runDropContactInvestorStageMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(contacts)') as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'investor_stage')) return
  db.exec(`ALTER TABLE contacts DROP COLUMN investor_stage`)
}
