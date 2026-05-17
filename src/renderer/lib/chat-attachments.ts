import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'

/**
 * File-attachment processing for chat composers.
 *
 *   File (image/text)         ┐
 *   File (cyggie repository)  ├─▶  PendingAttachment  ─▶  ChatAttachmentIPC (sent over IPC)
 *   text/* paste/drop         ┘
 *
 * Caps enforced here so both the legacy bottom-pill and the new panel composer
 * share the same limits. Callers receive an explicit { ok, value | error } so
 * they can show a single inline error per drop.
 */

/** 10 MB per file. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** 10 files per drop. */
export const MAX_ATTACHMENTS_PER_DROP = 10

export interface PendingAttachment {
  name: string
  mimeType: string
  type: 'image' | 'text'
  /** text content, or base64 (without `data:` prefix) for images */
  data: string
  /** object URL for image thumbnails — must be revoked when removed */
  previewUrl?: string
}

/** What gets sent over IPC (no `previewUrl` — it's renderer-only). */
export interface ChatAttachmentIPC {
  name: string
  mimeType: string
  type: 'image' | 'text'
  data: string
}

export type AttachmentResult =
  | { ok: true; attachment: PendingAttachment }
  | { ok: false; error: string; name: string }

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Convert a single File to a PendingAttachment. Returns { ok: false } on
 * oversize, read failure, or unsupported type.
 */
export async function processFile(file: File): Promise<AttachmentResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      name: file.name,
      error: `${file.name} is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB).`,
    }
  }
  try {
    if (file.type.startsWith('image/')) {
      const data = await readFileAsBase64(file)
      const previewUrl = URL.createObjectURL(file)
      return { ok: true, attachment: { name: file.name, mimeType: file.type, type: 'image', data, previewUrl } }
    } else {
      const text = await readFileAsText(file)
      return { ok: true, attachment: { name: file.name, mimeType: file.type || 'text/plain', type: 'text', data: text } }
    }
  } catch (err) {
    return { ok: false, name: file.name, error: `Couldn't read ${file.name}: ${String(err)}` }
  }
}

/**
 * Process a batch of dropped/pasted files with the per-drop count cap applied.
 * Returns a summary with successes and any errors so the caller can show one
 * inline error if anything was rejected.
 */
export async function processFiles(files: File[]): Promise<{
  attachments: PendingAttachment[]
  errors: string[]
  truncated: boolean
}> {
  const truncated = files.length > MAX_ATTACHMENTS_PER_DROP
  const limited = truncated ? files.slice(0, MAX_ATTACHMENTS_PER_DROP) : files
  const results = await Promise.all(limited.map(processFile))
  const attachments: PendingAttachment[] = []
  const errors: string[] = []
  for (const r of results) {
    if (r.ok) attachments.push(r.attachment)
    else errors.push(r.error)
  }
  if (truncated) {
    errors.push(`Only the first ${MAX_ATTACHMENTS_PER_DROP} files were attached.`)
  }
  return { attachments, errors, truncated }
}

/**
 * Read a Cyggie-internal file (drag from CompanyFiles tab) by its flagged
 * file ID. Returns the same PendingAttachment shape as the OS-file path.
 *
 * PR2 capability flow: the renderer passes `id` (Drive id or local path —
 * same shape as `company_flagged_files.file_id`) along with `companyId`,
 * `fileName`, and `mimeType` so main can auto-flag the file if it isn't
 * already flagged. This preserves the "drag any listed company file"
 * UX while ensuring main never reads renderer-arbitrary paths.
 */
export async function loadCyggieFile(
  id: string,
  companyId: string,
  fileName: string,
  mimeType?: string | null,
): Promise<AttachmentResult> {
  try {
    const result = await api.invoke<{ content: string | null; error: string | null }>(
      IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
      { id, companyId, fileName, mimeType: mimeType ?? null },
    )
    if (result.content) {
      return {
        ok: true,
        attachment: { name: fileName, mimeType: mimeType || 'text/plain', type: 'text', data: result.content },
      }
    }
    return { ok: false, name: fileName, error: result.error || `Couldn't read ${fileName}` }
  } catch (err) {
    return { ok: false, name: fileName, error: `Couldn't read ${fileName}: ${String(err)}` }
  }
}

/** Strip `previewUrl` for IPC. */
export function toIPCAttachment(a: PendingAttachment): ChatAttachmentIPC {
  return { name: a.name, mimeType: a.mimeType, type: a.type, data: a.data }
}

/** Revoke any object URLs held by an attachment. Safe to call repeatedly. */
export function revokePreview(a: PendingAttachment): void {
  if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
}
