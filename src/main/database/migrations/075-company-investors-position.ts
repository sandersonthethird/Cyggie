/**
 * Migration 075 — add ordering to company_investors.
 *
 * Phase 2A: users want to drag-reorder investor chips (lead investor first,
 * etc.). Adds a `position` column. Existing rows are backfilled by
 * created_at order so display order stays stable for users who haven't
 * dragged yet.
 *
 * Idempotent: PRAGMA table_info check before ALTER TABLE; CREATE INDEX
 * IF NOT EXISTS; backfill only runs on rows where position = 0 across an
 * entire (company_id, investor_type) group (the post-ALTER default state).
 */
import type Database from 'better-sqlite3'

export function runCompanyInvestorsPositionMigration(db: Database.Database): void {
  const tableInfo = db.prepare(`PRAGMA table_info(company_investors)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((col) => col.name))

  if (!existingColumns.has('position')) {
    db.exec(`ALTER TABLE company_investors ADD COLUMN position INTEGER NOT NULL DEFAULT 0;`)
    console.log('[migration-075] Added position column to company_investors')
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_company_investors_position
      ON company_investors(company_id, investor_type, position);
  `)

  // Backfill: assign ascending position by created_at within each (company_id, investor_type) group.
  // Only touches groups where every row still has position = 0 (the freshly-added default state).
  // Once any user drags chips, that group's positions become non-zero and we leave it alone.
  const groupsNeedingBackfill = db.prepare(`
    SELECT company_id, investor_type
    FROM company_investors
    GROUP BY company_id, investor_type
    HAVING SUM(CASE WHEN position != 0 THEN 1 ELSE 0 END) = 0
       AND COUNT(*) > 1
  `).all() as Array<{ company_id: string; investor_type: string }>

  if (groupsNeedingBackfill.length === 0) return

  const updateStmt = db.prepare(`UPDATE company_investors SET position = ? WHERE id = ?`)
  const fetchOrdered = db.prepare(`
    SELECT id FROM company_investors
    WHERE company_id = ? AND investor_type = ?
    ORDER BY created_at, id
  `)

  db.transaction(() => {
    for (const group of groupsNeedingBackfill) {
      const rows = fetchOrdered.all(group.company_id, group.investor_type) as Array<{ id: string }>
      rows.forEach((row, idx) => updateStmt.run(idx, row.id))
    }
  })()

  console.log(`[migration-075] Backfilled position for ${groupsNeedingBackfill.length} investor groups`)
}
