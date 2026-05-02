import type Database from 'better-sqlite3'

/**
 * Consolidates company industry storage:
 *  - org_companies.sector (TEXT)
 *  - industries (master table)
 *  - org_company_industries (join)
 * Into a single org_companies.industry TEXT column backed by a builtin
 * picker definition in custom_field_definitions.
 *
 * Also aligns contacts.investment_sector_focus to the same canonical list:
 *  - existing free-form narrative values move to investment_sector_focus_notes
 *  - investment_sector_focus becomes CSV-of-canonical-industries (cleared here;
 *    the picker UI repopulates it)
 *
 * Idempotent — safe to re-run.
 */
export function runIndustryConsolidationMigration(db: Database.Database): void {
  const orgCompaniesCols = new Set(
    (db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>).map((c) => c.name),
  )
  const contactsCols = new Set(
    (db.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name: string }>).map((c) => c.name),
  )

  const apply = db.transaction(() => {
    // ── Companies side ───────────────────────────────────────────────────
    if (!orgCompaniesCols.has('industry')) {
      db.exec(`ALTER TABLE org_companies ADD COLUMN industry TEXT`)
    }

    if (orgCompaniesCols.has('sector')) {
      // Backfill from sector → industry only when industry is empty (don't clobber
      // any value the new column may already hold from a partial prior run).
      db.exec(`
        UPDATE org_companies
        SET industry = CASE sector
          WHEN 'DevTools'       THEN 'Developer Tools'
          WHEN 'HRTech'         THEN 'HR Tech'
          WHEN 'ConsumerSocial' THEN 'Consumer Social'
          WHEN 'CreatorEconomy' THEN 'Creator Economy'
          WHEN 'DTC'            THEN 'Consumer (CPG)'
          ELSE sector
        END
        WHERE (industry IS NULL OR industry = '')
          AND sector IS NOT NULL
          AND sector <> ''
      `)
      db.exec(`ALTER TABLE org_companies DROP COLUMN sector`)
    }

    db.exec(`DROP TABLE IF EXISTS org_company_industries`)
    db.exec(`DROP TABLE IF EXISTS industries`)

    // ── Contacts side ────────────────────────────────────────────────────
    if (!contactsCols.has('investment_sector_focus_notes')) {
      db.exec(`ALTER TABLE contacts ADD COLUMN investment_sector_focus_notes TEXT`)
    }

    // Move existing narrative values into the notes field, clear the picker
    // field. Only operates on rows that haven't already been migrated.
    db.exec(`
      UPDATE contacts
      SET investment_sector_focus_notes = investment_sector_focus,
          investment_sector_focus = NULL
      WHERE investment_sector_focus IS NOT NULL
        AND investment_sector_focus <> ''
        AND (investment_sector_focus_notes IS NULL OR investment_sector_focus_notes = '')
    `)

    // ── Builtin field defs (mirror migration 046) ───────────────────────
    db.exec(`
      INSERT OR IGNORE INTO custom_field_definitions
        (id, entity_type, field_key, label, field_type, options_json, is_builtin,
         is_required, sort_order, show_in_list, created_at, updated_at)
      VALUES
        ('builtin:industry',              'company', 'industry',              'Industry',     'select',       NULL, 1, 0, -92, 0, datetime('now'), datetime('now')),
        ('builtin:investmentSectorFocus', 'contact', 'investmentSectorFocus', 'Sector Focus', 'multi-select', NULL, 1, 0, -98, 0, datetime('now'), datetime('now'))
    `)
  })

  apply()
}
