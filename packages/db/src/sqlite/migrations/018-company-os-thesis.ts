import type Database from 'better-sqlite3'

export function runCompanyOsThesisMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS theses (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      theme_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      conviction_score INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE,
      CHECK (company_id IS NOT NULL OR theme_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_theses_company ON theses(company_id);
    CREATE INDEX IF NOT EXISTS idx_theses_theme ON theses(theme_id);

    CREATE TABLE IF NOT EXISTS thesis_claims (
      id TEXT PRIMARY KEY,
      thesis_id TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      claim_type TEXT NOT NULL DEFAULT 'support',
      confidence REAL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thesis_id) REFERENCES theses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thesis_claims_thesis ON thesis_claims(thesis_id);

    CREATE TABLE IF NOT EXISTS evidence_links (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      snippet_text TEXT NOT NULL,
      snippet_start INTEGER,
      snippet_end INTEGER,
      source_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_artifact ON evidence_links(artifact_id);

    CREATE TABLE IF NOT EXISTS thesis_claim_evidence (
      claim_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (claim_id, evidence_id),
      FOREIGN KEY (claim_id) REFERENCES thesis_claims(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES evidence_links(id) ON DELETE CASCADE
    );
  `)
}
