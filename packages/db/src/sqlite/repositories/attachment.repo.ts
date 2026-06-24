import { getDatabase } from '../connection'

// =============================================================================
// attachment.repo.ts — note/memo attachment METADATA (bytes live in R2).
//
// Raw repo (test-only direct import). PRODUCTION code imports the withSync-
// wrapped `createAttachment` / `softDeleteAttachment` from the barrel
// (`@cyggie/db/sqlite/repositories`) so writes flow through the outbox.
//
// SYNC PAYLOAD SHAPE: the wrapped functions return the full camelCase row; the
// withSync wrapper emits it to the outbox. The row deliberately OMITS `lamport`
// — the per-transaction clock is stamped by the wrapper (ctx.lamport) onto the
// outbox entry, so carrying lamport in the payload would clobber it (mirrors
// notes/memos). `id` is client-minted (cuid2) and passed in by the caller.
// =============================================================================

export type AttachmentOwnerType = 'note' | 'memo'
export type AttachmentKind = 'image' | 'pdf'

interface AttachmentRow {
  id: string
  owner_type: string
  owner_id: string
  user_id: string | null
  kind: string
  filename: string
  mime_type: string
  size_bytes: number
  storage_key: string
  checksum: string | null
  width: number | null
  height: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Attachment {
  id: string
  ownerType: string
  ownerId: string
  userId: string | null
  kind: string
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  checksum: string | null
  width: number | null
  height: number | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface AttachmentCreateData {
  id: string
  ownerType: AttachmentOwnerType
  ownerId: string
  kind: AttachmentKind
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  checksum?: string | null
  width?: number | null
  height?: number | null
}

const COLUMNS = `
  id, owner_type, owner_id, user_id, kind, filename, mime_type, size_bytes,
  storage_key, checksum, width, height, created_at, updated_at, deleted_at
`

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    userId: row.user_id,
    kind: row.kind,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
    checksum: row.checksum,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  }
}

/** Active (not soft-deleted) attachment by id. */
export function getAttachment(id: string): Attachment | null {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as AttachmentRow | undefined
  return row ? rowToAttachment(row) : null
}

/**
 * Insert a new attachment metadata row. `id` is client-minted (cuid2). `userId`
 * is stamped locally so the desktop GC can scope to own rows (the gateway
 * re-stamps it from JWT on push). Returns the full row for the outbox payload.
 */
export function createAttachment(
  data: AttachmentCreateData,
  userId: string | null = null,
): Attachment | null {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO attachments (
       id, owner_type, owner_id, user_id, kind, filename, mime_type, size_bytes,
       storage_key, checksum, width, height, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    data.id,
    data.ownerType,
    data.ownerId,
    userId,
    data.kind,
    data.filename,
    data.mimeType,
    data.sizeBytes,
    data.storageKey,
    data.checksum ?? null,
    data.width ?? null,
    data.height ?? null,
  )
  return getAttachment(data.id)
}

/**
 * Soft-delete — sets deleted_at (op:'update' in the wrapper, NOT a row delete)
 * so the deletion replicates cross-device. Returns the post-delete row WITHOUT
 * the deleted_at guard (getAttachment would filter it out) so the wrapper emits
 * a full-row UPDATE carrying deleted_at. Returns null on no-op (already deleted /
 * missing) so the wrapper emits nothing.
 */
export function softDeleteAttachment(
  id: string,
  _userId: string | null = null,
): Attachment | null {
  const db = getDatabase()
  const result = db
    .prepare(
      `UPDATE attachments
       SET deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(id)
  if (result.changes === 0) return null
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`)
    .get(id) as AttachmentRow | undefined
  return row ? rowToAttachment(row) : null
}

/**
 * GC support: active attachment rows OWNED BY `userId` (id + created_at + the
 * referencing owner). The GC scans note/memo content for `cyggie-attachment://`
 * ids and soft-deletes the rows here whose id appears nowhere past a grace
 * window. Own-rows-only so a teammate's attachment (referenced solely in their
 * non-pulled private note) is never false-orphaned.
 */
export function listOwnActiveAttachmentsForGc(
  userId: string,
): { id: string; createdAt: string }[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT id, created_at FROM attachments
       WHERE user_id = ? AND deleted_at IS NULL`,
    )
    .all(userId) as { id: string; created_at: string }[]
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at }))
}

// Matches `cyggie-attachment://{cuid2}` references in markdown (image src or PDF
// link href). Source string is rebuilt per call (global regex is stateful).
function attachmentRefRe(): RegExp {
  return /cyggie-attachment:\/\/([a-z0-9]{1,32})/g
}

/** Pure: every `cyggie-attachment://{id}` reference in a markdown body. */
export function extractAttachmentRefs(text: string | null | undefined): string[] {
  if (!text) return []
  const ids: string[] = []
  for (const m of text.matchAll(attachmentRefRe())) ids.push(m[1])
  return ids
}

/**
 * The set of attachment ids referenced by ANY local content — every active
 * note's `content` PLUS every `investment_memo_versions.content_markdown`
 * (ALL versions, not just latest, so an image still shown in memo history is
 * NOT false-orphaned). Scans the whole local view (all owners) so a teammate's
 * firm-shared note that references my attachment keeps it alive.
 */
export function collectReferencedAttachmentIds(): Set<string> {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT content AS text FROM notes WHERE deleted_at IS NULL
       UNION ALL
       SELECT content_markdown AS text FROM investment_memo_versions`,
    )
    .all() as { text: string | null }[]
  const ids = new Set<string>()
  for (const r of rows) {
    for (const id of extractAttachmentRefs(r.text)) ids.add(id)
  }
  return ids
}
