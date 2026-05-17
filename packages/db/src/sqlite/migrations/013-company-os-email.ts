import type Database from 'better-sqlite3'

export function runCompanyOsEmailMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_email TEXT NOT NULL,
      display_name TEXT,
      external_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      scopes_json TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, account_email)
    );

    CREATE TABLE IF NOT EXISTS email_sync_state (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      cursor TEXT,
      last_sync_started_at TEXT,
      last_sync_completed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
      UNIQUE(account_id, mailbox)
    );

    CREATE TABLE IF NOT EXISTS email_threads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      subject TEXT,
      snippet TEXT,
      first_message_at TEXT,
      last_message_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
      UNIQUE(account_id, provider_thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_threads_last_message ON email_threads(last_message_at);

    CREATE TABLE IF NOT EXISTS email_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      thread_id TEXT,
      provider_message_id TEXT NOT NULL,
      internet_message_id TEXT,
      direction TEXT NOT NULL,
      subject TEXT,
      from_name TEXT,
      from_email TEXT NOT NULL,
      reply_to TEXT,
      sent_at TEXT,
      received_at TEXT,
      snippet TEXT,
      body_text TEXT,
      labels_json TEXT,
      is_unread INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      artifact_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id) REFERENCES email_threads(id) ON DELETE SET NULL,
      UNIQUE(account_id, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_messages_received ON email_messages(received_at);
    CREATE INDEX IF NOT EXISTS idx_email_messages_from ON email_messages(from_email);

    CREATE TABLE IF NOT EXISTS email_message_participants (
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      contact_id TEXT,
      domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, role, email),
      FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_participants_email ON email_message_participants(email);

    CREATE TABLE IF NOT EXISTS email_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      provider_attachment_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      storage_uri TEXT,
      artifact_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON email_attachments(message_id);

    CREATE TABLE IF NOT EXISTS email_company_links (
      message_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT NOT NULL DEFAULT 'auto',
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, company_id),
      FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_contact_links (
      message_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, contact_id),
      FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_theme_links (
      message_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, theme_id),
      FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
    );
  `)
}
