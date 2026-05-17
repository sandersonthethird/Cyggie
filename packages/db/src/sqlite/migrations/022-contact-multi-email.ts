import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_022_contact_multi_email_v1'

function normalizeEmailValue(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace(/^mailto:/, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

export function runContactMultiEmailMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_emails (
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (contact_id, email),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_emails_email ON contact_emails(email);
    CREATE INDEX IF NOT EXISTS idx_contact_emails_contact ON contact_emails(contact_id);
  `)

  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MIGRATION_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  const rows = db
    .prepare(`
      SELECT id, email, created_at
      FROM contacts
      WHERE email IS NOT NULL
    `)
    .all() as Array<{
    id: string
    email: string | null
    created_at: string | null
  }>

  const upsertContactEmail = db.prepare(`
    INSERT INTO contact_emails (contact_id, email, is_primary, created_at)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(contact_id, email) DO UPDATE SET
      is_primary = CASE
        WHEN excluded.is_primary = 1 THEN 1
        ELSE contact_emails.is_primary
      END
  `)

  const tx = db.transaction((items: typeof rows) => {
    for (const row of items) {
      const normalized = normalizeEmailValue(row.email || '')
      if (!normalized) continue
      upsertContactEmail.run(row.id, normalized, 1, row.created_at)
    }
  })

  tx(rows)

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(MIGRATION_KEY)
}
