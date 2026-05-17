import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_033_user_name_parts_v1'

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>
  return columns.some((col) => col.name === columnName)
}

function splitNameParts(displayName: string): { firstName: string | null; lastName: string | null } {
  const tokens = displayName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
  if (tokens.length === 0) return { firstName: null, lastName: null }
  if (tokens.length === 1) return { firstName: tokens[0], lastName: null }
  return {
    firstName: tokens[0] || null,
    lastName: tokens.slice(1).join(' ') || null
  }
}

export function runUserNamePartsMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  if (!columnExists(db, 'users', 'first_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT`)
  }
  if (!columnExists(db, 'users', 'last_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN last_name TEXT`)
  }

  const rows = db.prepare(`
    SELECT id, display_name, first_name, last_name
    FROM users
  `).all() as Array<{
    id: string
    display_name: string
    first_name: string | null
    last_name: string | null
  }>

  const update = db.prepare(`
    UPDATE users
    SET first_name = ?, last_name = ?
    WHERE id = ?
  `)

  for (const row of rows) {
    const currentFirst = (row.first_name || '').trim()
    const currentLast = (row.last_name || '').trim()
    if (currentFirst || currentLast) continue
    const split = splitNameParts(row.display_name || '')
    if (!split.firstName && !split.lastName) continue
    update.run(split.firstName, split.lastName, row.id)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
