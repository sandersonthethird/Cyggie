import { getDatabase } from '../connection'
import type { AttachmentKind, AttachmentOwnerType } from './attachment.repo'

// =============================================================================
// attachment-uploads.repo.ts — the LOCAL "byte outbox": image bytes queued for
// background upload to object storage. Operational state like the sync `outbox`
// (NOT synced, NO withSync, never reaches Neon). The flusher drains it.
// =============================================================================

export type AttachmentUploadStatus = 'pending' | 'failed' | 'dead'

export interface AttachmentUpload {
  id: number
  attachmentId: string
  userId: string | null
  ownerType: string
  ownerId: string
  filename: string
  mimeType: string
  sizeBytes: number
  checksum: string | null
  status: AttachmentUploadStatus
  attempts: number
  lastError: string | null
  createdAt: string
}

export interface EnqueueUploadData {
  attachmentId: string
  userId: string | null
  ownerType: AttachmentOwnerType
  ownerId: string
  kind: AttachmentKind
  filename: string
  mimeType: string
  sizeBytes: number
  checksum: string | null
}

interface UploadRow {
  id: number
  attachment_id: string
  user_id: string | null
  owner_type: string
  owner_id: string
  filename: string
  mime_type: string
  size_bytes: number
  checksum: string | null
  status: string
  attempts: number
  last_error: string | null
  created_at: string
}

function rowToUpload(r: UploadRow): AttachmentUpload {
  return {
    id: r.id,
    attachmentId: r.attachment_id,
    userId: r.user_id,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    checksum: r.checksum,
    status: r.status as AttachmentUploadStatus,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  }
}

/** Enqueue a pending upload (idempotent on attachment_id via the UNIQUE index). */
export function enqueueUpload(data: EnqueueUploadData): void {
  getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO attachment_uploads (
         attachment_id, user_id, owner_type, owner_id, filename, mime_type,
         size_bytes, checksum, status
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      data.attachmentId,
      data.userId,
      data.ownerType,
      data.ownerId,
      data.filename,
      data.mimeType,
      data.sizeBytes,
      data.checksum,
    )
}

/** Pending (not dead/failed-permanently) uploads, oldest first. */
export function listPendingUploads(limit = 20): AttachmentUpload[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM attachment_uploads
       WHERE status IN ('pending', 'failed')
       ORDER BY id ASC LIMIT ?`,
    )
    .all(limit) as UploadRow[]
  return rows.map(rowToUpload)
}

/** Mark the result of an upload attempt (failed/dead bump attempts + record error). */
export function markUploadResult(
  id: number,
  status: AttachmentUploadStatus,
  error: string | null,
): void {
  getDatabase()
    .prepare(
      `UPDATE attachment_uploads
       SET status = ?, attempts = attempts + 1, last_error = ?
       WHERE id = ?`,
    )
    .run(status, error, id)
}

/** Remove a queue row (upload succeeded, or its attachment was deleted). */
export function deleteUpload(id: number): void {
  getDatabase().prepare(`DELETE FROM attachment_uploads WHERE id = ?`).run(id)
}

/** Remove the queue row for an attachment id (used on delete-before-upload). */
export function deleteUploadByAttachmentId(attachmentId: string): void {
  getDatabase().prepare(`DELETE FROM attachment_uploads WHERE attachment_id = ?`).run(attachmentId)
}

/**
 * The set of attachment ids with a queue row (any status). The cache size-cap
 * eviction excludes these so it can't drop bytes the flusher still needs.
 */
export function listPendingUploadIds(): Set<string> {
  const rows = getDatabase()
    .prepare(`SELECT attachment_id FROM attachment_uploads`)
    .all() as { attachment_id: string }[]
  return new Set(rows.map((r) => r.attachment_id))
}

/** Count by status, for surfacing dead/pending counts (status UI / logs). */
export function countUploadsByStatus(): { pending: number; failed: number; dead: number } {
  const r = getDatabase()
    .prepare(
      `SELECT
         sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
       FROM attachment_uploads`,
    )
    .get() as { pending: number | null; failed: number | null; dead: number | null }
  return { pending: r.pending ?? 0, failed: r.failed ?? 0, dead: r.dead ?? 0 }
}
