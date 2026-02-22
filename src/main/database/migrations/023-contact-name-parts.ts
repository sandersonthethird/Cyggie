import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_023_contact_name_parts_v1'

function splitNameParts(fullName: string): { firstName: string | null; lastName: string | null } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length !== 2) {
    return { firstName: null, lastName: null }
  }

  return {
    firstName: tokens[0] || null,
    lastName: tokens[1] || null
  }
}

function hasValue(value: string | null | undefined): boolean {
  return Boolean((value || '').trim())
}

export function runContactNamePartsMigration(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>
  const columnSet = new Set(columns.map((column) => column.name))

  if (!columnSet.has('first_name')) {
    db.exec('ALTER TABLE contacts ADD COLUMN first_name TEXT')
  }
  if (!columnSet.has('last_name')) {
    db.exec('ALTER TABLE contacts ADD COLUMN last_name TEXT')
  }

  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MIGRATION_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  const rows = db
    .prepare(`
      SELECT id, full_name, first_name, last_name
      FROM contacts
    `)
    .all() as Array<{
    id: string
    full_name: string | null
    first_name: string | null
    last_name: string | null
  }>

  const updateNameParts = db.prepare(`
    UPDATE contacts
    SET
      first_name = ?,
      last_name = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `)

  const tx = db.transaction((items: typeof rows) => {
    for (const row of items) {
      if (hasValue(row.first_name) || hasValue(row.last_name)) continue

      const { firstName, lastName } = splitNameParts(row.full_name || '')
      if (!firstName || !lastName) continue
      updateNameParts.run(firstName, lastName, row.id)
    }
  })

  tx(rows)

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(MIGRATION_KEY)
}
