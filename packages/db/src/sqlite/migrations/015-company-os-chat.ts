import type Database from 'better-sqlite3'

export function runCompanyOsChatMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_conversations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      theme_id TEXT,
      title TEXT NOT NULL,
      model_provider TEXT,
      model_name TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_company_conversations_company ON company_conversations(company_id);
    CREATE INDEX IF NOT EXISTS idx_company_conversations_last_msg ON company_conversations(last_message_at);

    CREATE TABLE IF NOT EXISTS company_conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES company_conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_company_conversation_messages_conv ON company_conversation_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_company_conversation_messages_created ON company_conversation_messages(created_at);
  `)
}
