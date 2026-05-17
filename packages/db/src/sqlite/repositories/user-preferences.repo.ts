import type Database from 'better-sqlite3'

export function getAllPreferences(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM user_preferences').all() as {
    key: string
    value: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function setPreference(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO user_preferences (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value)
}
