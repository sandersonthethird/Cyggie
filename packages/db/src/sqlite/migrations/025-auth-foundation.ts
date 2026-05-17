import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_025_auth_foundation_v1'

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined
  return Boolean(row?.name)
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) return false
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
): void {
  if (!tableExists(db, tableName)) return
  if (columnExists(db, tableName, columnName)) return
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

export function runAuthFoundationMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT UNIQUE,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(role IN ('admin', 'member'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CHECK(role IN ('admin', 'member'))
    );
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      changes_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS app_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event_name TEXT NOT NULL,
      properties_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_events_name ON app_events(event_name);
    CREATE INDEX IF NOT EXISTS idx_app_events_created ON app_events(created_at);
  `)

  const ownershipTables = [
    'org_companies',
    'contacts',
    'deals',
    'deal_stage_events',
    'company_notes',
    'company_conversations',
    'company_conversation_messages',
    'investment_memos',
    'investment_memo_versions',
    'meeting_company_links',
    'email_company_links',
    'meetings'
  ]

  for (const tableName of ownershipTables) {
    addColumnIfMissing(
      db,
      tableName,
      'created_by_user_id',
      'TEXT REFERENCES users(id) ON DELETE SET NULL'
    )
    addColumnIfMissing(
      db,
      tableName,
      'updated_by_user_id',
      'TEXT REFERENCES users(id) ON DELETE SET NULL'
    )
    if (columnExists(db, tableName, 'created_by_user_id')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${tableName}_created_by ON ${tableName}(created_by_user_id)`)
    }
    if (columnExists(db, tableName, 'updated_by_user_id')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${tableName}_updated_by ON ${tableName}(updated_by_user_id)`)
    }
  }

  addColumnIfMissing(
    db,
    'email_accounts',
    'user_id',
    'TEXT REFERENCES users(id) ON DELETE SET NULL'
  )
  if (columnExists(db, 'email_accounts', 'user_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts(user_id)')
  }

  const existingTeam = db.prepare('SELECT id FROM teams LIMIT 1').get() as { id: string } | undefined
  if (!existingTeam) {
    db.prepare(`
      INSERT INTO teams (id, name, created_at)
      VALUES (?, 'Default Workspace', datetime('now'))
    `).run(randomUUID())
  }

  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MIGRATION_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(MIGRATION_KEY)
}
