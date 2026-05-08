import { getDatabase } from '../connection'
import { randomUUID } from 'crypto'

export interface FlaggedFile {
  fileId: string
  fileName: string
  mimeType: string | null
}

/** Mime-aware listing — preferred for chat-context dispatch. */
export function getFlaggedFiles(companyId: string): FlaggedFile[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      'SELECT file_id, file_name, mime_type FROM company_flagged_files WHERE company_id = ? ORDER BY flagged_at ASC',
    )
    .all(companyId) as Array<{ file_id: string; file_name: string; mime_type: string | null }>
  return rows.map((r) => ({ fileId: r.file_id, fileName: r.file_name, mimeType: r.mime_type }))
}

/** Backwards-compat shim — returns just the file IDs. New consumers should
 *  prefer `getFlaggedFiles()` so they have mimeType for dispatch. */
export function getFlaggedFileIds(companyId: string): string[] {
  return getFlaggedFiles(companyId).map((f) => f.fileId)
}

/** Toggles a file's flagged state. Returns true if now flagged, false if unflagged.
 *  `mimeType` is stored so the chat-context reader knows whether to take the
 *  local-file path or the Drive-export path. */
export function toggleFileFlag(
  companyId: string,
  fileId: string,
  fileName: string,
  mimeType?: string | null,
): boolean {
  const db = getDatabase()
  const existing = db
    .prepare('SELECT id FROM company_flagged_files WHERE company_id = ? AND file_id = ?')
    .get(companyId, fileId)

  if (existing) {
    db.prepare('DELETE FROM company_flagged_files WHERE company_id = ? AND file_id = ?').run(
      companyId,
      fileId,
    )
    return false
  }

  db.prepare(
    `INSERT INTO company_flagged_files (id, company_id, file_id, file_name, mime_type, flagged_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(randomUUID(), companyId, fileId, fileName, mimeType ?? null)
  return true
}
