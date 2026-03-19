import type Database from 'better-sqlite3'

export function runCompanyNewFieldsMigration(db: Database.Database): void {
  // Guard: already migrated (check for table + columns)
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='company_investors'`)
    .get()

  if (!tableExists) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE company_investors (
          id                  TEXT NOT NULL PRIMARY KEY,
          company_id          TEXT NOT NULL,
          investor_company_id TEXT NOT NULL,
          investor_type       TEXT NOT NULL,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (company_id)          REFERENCES org_companies(id) ON DELETE CASCADE,
          FOREIGN KEY (investor_company_id) REFERENCES org_companies(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_company_investors_company  ON company_investors(company_id);
        CREATE INDEX idx_company_investors_investor ON company_investors(investor_company_id);
      `)
    })()
    console.log('[migration-056] Created company_investors table')
  }

  // Each ALTER TABLE is wrapped individually for idempotency
  const alterColumns = [
    { name: 'source_type',        sql: `ALTER TABLE org_companies ADD COLUMN source_type TEXT` },
    { name: 'source_entity_type', sql: `ALTER TABLE org_companies ADD COLUMN source_entity_type TEXT` },
    { name: 'source_entity_id',   sql: `ALTER TABLE org_companies ADD COLUMN source_entity_id TEXT` },
  ]

  for (const { name, sql } of alterColumns) {
    try {
      db.exec(sql)
      console.log(`[migration-056] Added column ${name} to org_companies`)
    } catch {
      // Column already exists — idempotent
    }
  }

  // Index on source_entity_id for reverse lookups
  try {
    db.exec(`CREATE INDEX idx_org_companies_source_entity ON org_companies(source_entity_id)`)
  } catch {
    // Index already exists
  }
}
