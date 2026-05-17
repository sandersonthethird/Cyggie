/**
 * Migration 076 — convert `lead_investor` text to a chip relationship.
 *
 * Phase 2B: the `lead_investor` field on org_companies has been a free-form
 * TEXT field. We want it to behave like co_investors (clickable chip,
 * autocomplete, find-or-create). To do that, we need a foreign-key column
 * (`lead_investor_company_id`) that links to another row in org_companies.
 *
 * Steps:
 *   1. ALTER TABLE org_companies ADD COLUMN lead_investor_company_id TEXT
 *      (idempotent via PRAGMA check)
 *   2. Backfill: for each row with non-null `lead_investor` text and
 *      null `lead_investor_company_id`, find-or-create a company stub by
 *      normalized name and link it.
 *   3. The text column is preserved for backward compat — write paths
 *      keep both fields in sync.
 *
 * Note: this migration deliberately re-implements normalizeCompanyName +
 * find-or-create inline rather than importing from org-company.repo.ts —
 * that file's functions call getDatabase() which would create a circular
 * dependency at startup (this migration runs from inside getDatabase()).
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function runLeadInvestorCompanyIdMigration(db: Database.Database): void {
  // Step 1 — add column if missing
  const tableInfo = db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((c) => c.name))

  if (!existingColumns.has('lead_investor_company_id')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN lead_investor_company_id TEXT;`)
    console.log('[migration-076] Added lead_investor_company_id column to org_companies')
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_companies_lead_investor
      ON org_companies(lead_investor_company_id);
  `)

  // Step 2 — backfill
  const rows = db
    .prepare(`
      SELECT id, lead_investor
      FROM org_companies
      WHERE lead_investor IS NOT NULL
        AND TRIM(lead_investor) <> ''
        AND lead_investor_company_id IS NULL
    `)
    .all() as Array<{ id: string; lead_investor: string }>

  if (rows.length === 0) return

  const findExisting = db.prepare(
    `SELECT id FROM org_companies WHERE normalized_name = ? LIMIT 1`
  )
  const insertStub = db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, status, entity_type,
      include_in_companies_view, classification_source, classification_confidence,
      created_at, updated_at
    )
    VALUES (?, ?, ?, 'active', 'unknown', 1, 'manual', 1, datetime('now'), datetime('now'))
    ON CONFLICT(normalized_name) DO NOTHING
  `)
  const updateLeadFK = db.prepare(
    `UPDATE org_companies SET lead_investor_company_id = ? WHERE id = ?`
  )

  let backfilled = 0
  let createdStubs = 0

  db.transaction(() => {
    for (const row of rows) {
      const trimmed = row.lead_investor.trim()
      if (!trimmed) continue

      const normalized = normalizeCompanyName(trimmed)
      if (!normalized) continue

      // Skip self-references (a company having itself as lead investor)
      // — possible from bad data but should not link.
      let leadId: string | null = null
      const existing = findExisting.get(normalized) as { id: string } | undefined
      if (existing && existing.id !== row.id) {
        leadId = existing.id
      } else if (!existing) {
        const newId = randomUUID()
        insertStub.run(newId, trimmed, normalized)
        // Re-fetch in case ON CONFLICT collapsed onto a newly-inserted dup
        const after = findExisting.get(normalized) as { id: string } | undefined
        leadId = after?.id ?? null
        if (leadId === newId) createdStubs++
      }

      if (leadId) {
        updateLeadFK.run(leadId, row.id)
        backfilled++
      }
    }
  })()

  console.log(
    `[migration-076] Backfilled lead_investor_company_id for ${backfilled} rows ` +
    `(created ${createdStubs} new stubs)`
  )
}
