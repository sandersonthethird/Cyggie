import { getDatabase } from '../connection'
import { randomUUID } from 'crypto'

export function getFlaggedFileIds(companyId: string): string[] {
  const db = getDatabase()
  const rows = db
    .prepare('SELECT file_id FROM company_flagged_files WHERE company_id = ? ORDER BY flagged_at ASC')
    .all(companyId) as Array<{ file_id: string }>
  return rows.map((r) => r.file_id)
}

/** Toggles a file's flagged state. Returns true if now flagged, false if unflagged. */
export function toggleFileFlag(companyId: string, fileId: string, fileName: string): boolean {
  const db = getDatabase()
  const existing = db
    .prepare('SELECT id FROM company_flagged_files WHERE company_id = ? AND file_id = ?')
    .get(companyId, fileId)

  if (existing) {
    db.prepare('DELETE FROM company_flagged_files WHERE company_id = ? AND file_id = ?').run(companyId, fileId)
    return false
  }

  db.prepare(
    `INSERT INTO company_flagged_files (id, company_id, file_id, file_name, flagged_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(randomUUID(), companyId, fileId, fileName)
  return true
}
