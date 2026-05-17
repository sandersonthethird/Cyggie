import type Database from 'better-sqlite3'

const BACKFILL_KEY = 'migration_020_company_classification_backfill_v1'

interface CompanyClassificationRow {
  id: string
  canonical_name: string
  primary_domain: string | null
  stage: string | null
  has_memo: number
  has_deal: number
  has_notes: number
  meeting_count: number
}

function inferEntityType(
  row: CompanyClassificationRow
): { entityType: string; includeInCompaniesView: number; confidence: number } {
  const sourceText = `${row.canonical_name} ${row.primary_domain || ''}`.toLowerCase()
  const vcHints = [
    'venture',
    'ventures',
    'capital',
    'vc',
    'fund',
    'partners',
    'seed',
    'angels',
    'angel'
  ]
  const hasVcHint = vcHints.some((hint) => sourceText.includes(hint))
  const hasProspectSignals =
    row.has_memo === 1
    || row.has_deal === 1
    || row.has_notes === 1
    || Boolean(row.stage)
    || row.meeting_count >= 3

  if (hasProspectSignals) {
    return { entityType: 'prospect', includeInCompaniesView: 1, confidence: 0.9 }
  }
  if (hasVcHint) {
    return { entityType: 'vc_fund', includeInCompaniesView: 0, confidence: 0.9 }
  }
  return { entityType: 'unknown', includeInCompaniesView: 0, confidence: 0.4 }
}

export function runCompanyClassificationMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('org_companies')").all() as { name: string }[]
  const colSet = new Set(cols.map((c) => c.name))

  if (!colSet.has('entity_type')) {
    db.exec("ALTER TABLE org_companies ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'unknown'")
  }
  if (!colSet.has('include_in_companies_view')) {
    db.exec("ALTER TABLE org_companies ADD COLUMN include_in_companies_view INTEGER NOT NULL DEFAULT 0")
  }
  if (!colSet.has('classification_source')) {
    db.exec("ALTER TABLE org_companies ADD COLUMN classification_source TEXT NOT NULL DEFAULT 'auto'")
  }
  if (!colSet.has('classification_confidence')) {
    db.exec('ALTER TABLE org_companies ADD COLUMN classification_confidence REAL')
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_org_companies_entity_type ON org_companies(entity_type)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_org_companies_include_view ON org_companies(include_in_companies_view)')

  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(BACKFILL_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  const rows = db
    .prepare(`
      SELECT
        c.id,
        c.canonical_name,
        c.primary_domain,
        c.stage,
        CASE WHEN EXISTS (
          SELECT 1 FROM investment_memos im WHERE im.company_id = c.id
        ) THEN 1 ELSE 0 END AS has_memo,
        CASE WHEN EXISTS (
          SELECT 1 FROM deals d WHERE d.company_id = c.id
        ) THEN 1 ELSE 0 END AS has_deal,
        CASE WHEN EXISTS (
          SELECT 1 FROM company_notes n WHERE n.company_id = c.id
        ) THEN 1 ELSE 0 END AS has_notes,
        (
          SELECT COUNT(1) FROM meeting_company_links l WHERE l.company_id = c.id
        ) AS meeting_count
      FROM org_companies c
    `)
    .all() as CompanyClassificationRow[]

  const updateClassification = db.prepare(`
    UPDATE org_companies
    SET
      entity_type = ?,
      include_in_companies_view = ?,
      classification_source = 'auto',
      classification_confidence = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `)

  const tx = db.transaction((items: CompanyClassificationRow[]) => {
    for (const row of items) {
      const inferred = inferEntityType(row)
      updateClassification.run(
        inferred.entityType,
        inferred.includeInCompaniesView,
        inferred.confidence,
        row.id
      )
    }
  })
  tx(rows)

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(BACKFILL_KEY)
}
