import { getDatabase } from '../connection'
import { randomUUID } from 'crypto'

// =============================================================================
// company-file-flags.repo.ts — raw SQLite functions for the
// company_flagged_files table. NEVER import these directly from production
// code; import from the barrel (`@cyggie/db/sqlite/repositories`) so writes
// flow through the sync outbox. Tests may import raw functions to bypass
// the outbox.
//
// Phase 3 split the legacy `toggleFileFlag` (binary INSERT-or-DELETE) into
// explicit verbs so each carries crisp sync semantics:
//
//   flagFile           — INSERT new row (no-op if (company,file) already
//                        flagged). Sets extraction_status='pending'.
//   unflagFile         — DELETE by (company,file). Returns void.
//   refreshFlaggedFile — UPDATE existing row's flagged_by + reset
//                        extracted_text/drive_version to NULL + set
//                        status='pending'. Worker re-extracts.
//   updateFlaggedFileExtraction — UPDATE by id for worker state transitions
//                        (pending → extracting → done/failed) + filling in
//                        extracted_text/extracted_at/drive_version.
//
// Broadcast (COMPANY_FLAGS_CHANGED IPC) lives in the IPC handler now, not
// here — the repo is pure data.
// =============================================================================

export interface FlaggedFileRow {
  id: string
  companyId: string
  userId: string | null
  fileId: string
  fileName: string
  mimeType: string | null
  flaggedAt: string
  extractedText: string | null
  extractedTextChars: number | null
  driveVersion: string | null
  flaggedByUserId: string | null
  extractionStatus: 'pending' | 'extracting' | 'done' | 'failed'
  extractionError: string | null
  extractedAt: string | null
  lamport: string
}

interface FlaggedFileRawRow {
  id: string
  company_id: string
  user_id: string | null
  file_id: string
  file_name: string
  mime_type: string | null
  flagged_at: string
  extracted_text: string | null
  extracted_text_chars: number | null
  drive_version: string | null
  flagged_by_user_id: string | null
  extraction_status: string
  extraction_error: string | null
  extracted_at: string | null
  lamport: string
}

function mapRow(r: FlaggedFileRawRow): FlaggedFileRow {
  return {
    id: r.id,
    companyId: r.company_id,
    userId: r.user_id,
    fileId: r.file_id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    flaggedAt: r.flagged_at,
    extractedText: r.extracted_text,
    extractedTextChars: r.extracted_text_chars,
    driveVersion: r.drive_version,
    flaggedByUserId: r.flagged_by_user_id,
    extractionStatus: r.extraction_status as FlaggedFileRow['extractionStatus'],
    extractionError: r.extraction_error,
    extractedAt: r.extracted_at,
    lamport: r.lamport,
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────

/** Pre-Phase-3 shape — kept for callers that just need fileId/fileName/mimeType.
 *  Existing chat-context formatter still calls this. */
export interface FlaggedFile {
  fileId: string
  fileName: string
  mimeType: string | null
}

export function getFlaggedFiles(companyId: string): FlaggedFile[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      'SELECT file_id, file_name, mime_type FROM company_flagged_files WHERE company_id = ? ORDER BY flagged_at ASC',
    )
    .all(companyId) as Array<{ file_id: string; file_name: string; mime_type: string | null }>
  return rows.map((r) => ({ fileId: r.file_id, fileName: r.file_name, mimeType: r.mime_type }))
}

/** Phase 3 — full row shape including extraction state, for the formatter
 *  + the renderer's status chip / refresh button / attribution. */
export function getFlaggedFilesDetailed(companyId: string): FlaggedFileRow[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT * FROM company_flagged_files WHERE company_id = ? ORDER BY flagged_at ASC`,
    )
    .all(companyId) as FlaggedFileRawRow[]
  return rows.map(mapRow)
}

/** Backwards-compat shim — returns just the file IDs. New consumers should
 *  prefer `getFlaggedFiles()` so they have mimeType for dispatch. */
export function getFlaggedFileIds(companyId: string): string[] {
  return getFlaggedFiles(companyId).map((f) => f.fileId)
}

export function isFlaggedAnywhere(fileId: string): boolean {
  const db = getDatabase()
  const row = db
    .prepare('SELECT 1 FROM company_flagged_files WHERE file_id = ? LIMIT 1')
    .get(fileId)
  return Boolean(row)
}

export function isFlaggedForCompany(companyId: string, fileId: string): boolean {
  const db = getDatabase()
  const row = db
    .prepare('SELECT 1 FROM company_flagged_files WHERE company_id = ? AND file_id = ? LIMIT 1')
    .get(companyId, fileId)
  return Boolean(row)
}

export function getFlaggedFileById(id: string): FlaggedFileRow | null {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT * FROM company_flagged_files WHERE id = ? LIMIT 1`)
    .get(id) as FlaggedFileRawRow | undefined
  return row ? mapRow(row) : null
}

export function getFlaggedFileByPair(
  companyId: string,
  fileId: string,
): FlaggedFileRow | null {
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT * FROM company_flagged_files WHERE company_id = ? AND file_id = ? LIMIT 1`,
    )
    .get(companyId, fileId) as FlaggedFileRawRow | undefined
  return row ? mapRow(row) : null
}

/** All rows that the extraction worker should process — used on boot to
 *  drain the queue + handle stuck 'extracting' rows from prior sessions. */
export function getPendingExtractionRows(): FlaggedFileRow[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT * FROM company_flagged_files
       WHERE extraction_status IN ('pending', 'extracting')
       ORDER BY flagged_at ASC`,
    )
    .all() as FlaggedFileRawRow[]
  return rows.map(mapRow)
}

// ─── Writes (must be wrapped via the barrel; raw access for tests only) ──

export interface FlagFileArgs {
  companyId: string
  fileId: string
  fileName: string
  mimeType?: string | null
  userId: string
  flaggedByUserId: string
}

/**
 * INSERT a new flag row. NO-OP (returns null) if (company_id, file_id)
 * already has a flag — re-flagging an already-flagged file is meaningless
 * (use refreshFlaggedFile to re-extract).
 *
 * Returns the new row on insert; null on no-op. The barrel's withSync
 * wrapper skips outbox emission when the result is null.
 */
export function flagFile(args: FlagFileArgs): FlaggedFileRow | null {
  const db = getDatabase()
  const existing = db
    .prepare(
      `SELECT id FROM company_flagged_files WHERE company_id = ? AND file_id = ?`,
    )
    .get(args.companyId, args.fileId) as { id: string } | undefined
  if (existing) return null // idempotent no-op

  const id = randomUUID()
  db.prepare(
    `INSERT INTO company_flagged_files
      (id, company_id, user_id, file_id, file_name, mime_type, flagged_at,
       extraction_status, flagged_by_user_id, lamport)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'pending', ?, '0')`,
  ).run(
    id,
    args.companyId,
    args.userId,
    args.fileId,
    args.fileName,
    args.mimeType ?? null,
    args.flaggedByUserId,
  )

  return getFlaggedFileById(id)
}

export interface UnflagFileArgs {
  companyId: string
  fileId: string
}

/**
 * DELETE the row matching (company_id, file_id). Returns void; the outbox
 * wrapper grabs the row via captureBeforeDelete and emits a delete payload
 * for the gateway to apply.
 */
export function unflagFile(args: UnflagFileArgs): void {
  const db = getDatabase()
  db.prepare(
    `DELETE FROM company_flagged_files WHERE company_id = ? AND file_id = ?`,
  ).run(args.companyId, args.fileId)
}

export interface RefreshFlaggedFileArgs {
  companyId: string
  fileId: string
  flaggedByUserId: string
}

/**
 * Re-flag (= refresh): mark the existing row for re-extraction. Clears
 * extracted_text + drive_version + extracted_at + extraction_error; sets
 * status back to 'pending'; updates flagged_by_user_id to the calling
 * user (multiplayer attribution — last to refresh "owns" it).
 *
 * Returns the updated row on success; null if no row exists for (company,
 * file) — caller should ensure the file is flagged first.
 */
export function refreshFlaggedFile(
  args: RefreshFlaggedFileArgs,
): FlaggedFileRow | null {
  const db = getDatabase()
  const existing = db
    .prepare(
      `SELECT id FROM company_flagged_files WHERE company_id = ? AND file_id = ?`,
    )
    .get(args.companyId, args.fileId) as { id: string } | undefined
  if (!existing) return null

  db.prepare(
    `UPDATE company_flagged_files
       SET extracted_text = NULL,
           extracted_text_chars = NULL,
           drive_version = NULL,
           extracted_at = NULL,
           extraction_error = NULL,
           extraction_status = 'pending',
           flagged_by_user_id = ?
     WHERE id = ?`,
  ).run(args.flaggedByUserId, existing.id)

  return getFlaggedFileById(existing.id)
}

export interface UpdateFlaggedFileExtractionPatch {
  extractionStatus: FlaggedFileRow['extractionStatus']
  extractedText?: string | null
  extractedTextChars?: number | null
  driveVersion?: string | null
  extractedAt?: string | null
  extractionError?: string | null
  // Backfill path — worker sets user_id on first run for pre-Phase-3 rows
  // that landed before the column existed.
  userId?: string | null
}

/**
 * UPDATE one row by primary id. Used by the extraction worker for state
 * transitions ('pending' → 'extracting' → 'done' / 'failed') and for
 * persisting the extracted text + Drive version at completion.
 *
 * Returns the updated row, or null if the id didn't exist (e.g. the row
 * was unflagged mid-extraction).
 */
export function updateFlaggedFileExtraction(
  id: string,
  patch: UpdateFlaggedFileExtractionPatch,
): FlaggedFileRow | null {
  const db = getDatabase()
  const existing = db
    .prepare(`SELECT id FROM company_flagged_files WHERE id = ?`)
    .get(id) as { id: string } | undefined
  if (!existing) return null

  const sets: string[] = ['extraction_status = ?']
  const values: unknown[] = [patch.extractionStatus]

  if (patch.extractedText !== undefined) {
    sets.push('extracted_text = ?')
    values.push(patch.extractedText)
  }
  if (patch.extractedTextChars !== undefined) {
    sets.push('extracted_text_chars = ?')
    values.push(patch.extractedTextChars)
  }
  if (patch.driveVersion !== undefined) {
    sets.push('drive_version = ?')
    values.push(patch.driveVersion)
  }
  if (patch.extractedAt !== undefined) {
    sets.push('extracted_at = ?')
    values.push(patch.extractedAt)
  }
  if (patch.extractionError !== undefined) {
    sets.push('extraction_error = ?')
    values.push(patch.extractionError)
  }
  if (patch.userId !== undefined) {
    sets.push('user_id = ?')
    values.push(patch.userId)
  }

  values.push(id)
  db.prepare(
    `UPDATE company_flagged_files SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...values)

  return getFlaggedFileById(id)
}
