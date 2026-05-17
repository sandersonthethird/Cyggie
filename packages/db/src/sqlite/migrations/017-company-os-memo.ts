import type Database from 'better-sqlite3'

export function runCompanyOsMemoMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS investment_memos (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      theme_id TEXT,
      deal_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      latest_version_number INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL,
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_investment_memos_company ON investment_memos(company_id);
    CREATE INDEX IF NOT EXISTS idx_investment_memos_status ON investment_memos(status);

    CREATE TABLE IF NOT EXISTS investment_memo_versions (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      structured_json TEXT,
      change_note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memo_id) REFERENCES investment_memos(id) ON DELETE CASCADE,
      UNIQUE(memo_id, version_number)
    );
    CREATE INDEX IF NOT EXISTS idx_investment_memo_versions_memo ON investment_memo_versions(memo_id);

    CREATE TABLE IF NOT EXISTS investment_memo_exports (
      id TEXT PRIMARY KEY,
      memo_version_id TEXT NOT NULL,
      artifact_id TEXT,
      export_format TEXT NOT NULL DEFAULT 'pdf',
      storage_uri TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (memo_version_id) REFERENCES investment_memo_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_investment_memo_exports_version ON investment_memo_exports(memo_version_id);
  `)
}
