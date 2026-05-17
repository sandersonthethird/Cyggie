import { getDatabase } from '../connection'
import type { SettingsRow } from '../schema'

export function getSetting(key: string): string | null {
  const db = getDatabase()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | Pick<SettingsRow, 'value'>
    | undefined
  return row ? row.value : null
}

export function setSetting(key: string, value: string): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
  ).run(key, value, value)
}

export function getAllSettings(): Record<string, string> {
  const db = getDatabase()
  const rows = db.prepare('SELECT key, value FROM settings').all() as Pick<
    SettingsRow,
    'key' | 'value'
  >[]
  const result: Record<string, string> = {}
  for (const row of rows) {
    result[row.key] = row.value
  }
  return result
}

export function deleteSetting(key: string): void {
  const db = getDatabase()
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}
