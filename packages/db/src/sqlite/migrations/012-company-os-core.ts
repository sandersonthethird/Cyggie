import type Database from 'better-sqlite3'

export function runCompanyOsCoreMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      description TEXT,
      primary_domain TEXT,
      website_url TEXT,
      stage TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      crm_provider TEXT,
      crm_company_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_org_companies_domain ON org_companies(primary_domain);
    CREATE INDEX IF NOT EXISTS idx_org_companies_status ON org_companies(status);

    CREATE TABLE IF NOT EXISTS org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      UNIQUE(company_id, alias_type, alias_value)
    );
    CREATE INDEX IF NOT EXISTS idx_org_company_aliases_value ON org_company_aliases(alias_value);

    CREATE TABLE IF NOT EXISTS industries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES industries(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS org_company_industries (
      company_id TEXT NOT NULL,
      industry_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      is_primary INTEGER NOT NULL DEFAULT 0,
      tagged_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, industry_id),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (industry_id) REFERENCES industries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_org_company_industries_primary ON org_company_industries(is_primary);

    CREATE TABLE IF NOT EXISTS themes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      thesis_statement TEXT,
      status TEXT NOT NULL DEFAULT 'exploring',
      conviction_score INTEGER,
      owner_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_themes_status ON themes(status);

    CREATE TABLE IF NOT EXISTS org_company_themes (
      company_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      relevance_score REAL NOT NULL DEFAULT 0.5,
      rationale TEXT,
      linked_by TEXT NOT NULL DEFAULT 'manual',
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, theme_id),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_org_company_themes_theme ON org_company_themes(theme_id);

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      pipeline_name TEXT,
      stage TEXT NOT NULL,
      stage_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      owner_name TEXT,
      crm_provider TEXT,
      crm_deal_id TEXT,
      amount_target_usd INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
    CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);

    CREATE TABLE IF NOT EXISTS deal_stage_events (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      event_time TEXT NOT NULL DEFAULT (datetime('now')),
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal ON deal_stage_events(deal_id);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      email TEXT,
      primary_company_id TEXT,
      title TEXT,
      linkedin_url TEXT,
      crm_contact_id TEXT,
      crm_provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (primary_company_id) REFERENCES org_companies(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(normalized_name);

    CREATE TABLE IF NOT EXISTS org_company_contacts (
      company_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      role_label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, contact_id),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
  `)
}
