import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_115_contact_target_investment_stage_v1'

/**
 * Promotes the contact "Target Investment Stage" field (investment_stage_focus)
 * from a free-text field to a multi-select dropdown, mirroring the company
 * targetInvestmentStage field. Adds a builtin custom-field definition so the
 * picker offers canonical stage options (Pre-Seed … Late Stage) and lets users
 * add new ones; existing comma-separated values ("Seed, Series A") render as
 * chips unchanged.
 *
 * Column choice rationale: the data lives in investment_stage_focus (all stage
 * values, already CSV) — the parallel investor_stage column is empty, so it was
 * dropped from the UI (column left in place, non-destructive). No data
 * consolidation is required.
 *
 * field_type is 'multi-select' (same shape as investmentSectorFocus, seeded in
 * migration 077). Idempotent via INSERT OR IGNORE + settings guard.
 */
export function runContactTargetInvestmentStageMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  db.exec(`
    INSERT OR IGNORE INTO custom_field_definitions
      (id, entity_type, field_key, label, field_type, options_json, is_builtin,
       is_required, sort_order, show_in_list, created_at, updated_at)
    VALUES
      ('builtin:investmentStageFocus', 'contact', 'investmentStageFocus', 'Target Investment Stage', 'multi-select', NULL, 1, 0, -97, 0, datetime('now'), datetime('now'))
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
