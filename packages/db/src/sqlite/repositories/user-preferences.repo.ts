import type Database from 'better-sqlite3'
import { getDatabase } from '../connection'

/**
 * Single-key read using the ambient DB handle (mirrors settings.repo
 * `getSetting`). Convenience for desktop read paths (e.g. chat context cap)
 * that don't already hold a `db`.
 */
export function getPreference(key: string): string | null {
  const row = getDatabase()
    .prepare('SELECT value FROM user_preferences WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row ? row.value : null
}

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
