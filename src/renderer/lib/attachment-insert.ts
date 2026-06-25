// =============================================================================
// attachment-insert.ts — renderer orchestration for inserting image attachments
// into a Tiptap editor.
//
//   pick/paste/drop File → validate → decoration preview (instant) →
//   getPathForFile → ATTACHMENT_UPLOAD IPC → on success swap the preview for a
//   real Image node (`cyggie-attachment://{id}`); on failure drop the preview.
//
// The reference reaches the document (and thus the autosave) ONLY after the
// upload confirms — see attachment-upload-extension.ts for why that matters.
// =============================================================================

import type { Editor } from '@tiptap/react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  ATTACHMENT_MAX_UPLOAD_BYTES,
  isRasterImageMime,
  imageMimeFromFilename,
} from '../../shared/attachments'

export type ImageFileValidation = { ok: true; mime: string } | { ok: false; reason: string }

/** PURE: validate a candidate image file (mime + non-empty + under the cap). */
export function validateImageFile(file: { name: string; type: string; size: number }): ImageFileValidation {
  const mime = isRasterImageMime(file.type) ? file.type : imageMimeFromFilename(file.name)
  if (!mime) return { ok: false, reason: 'Only PNG, JPG, GIF, or WebP images are supported.' }
  if (file.size === 0) return { ok: false, reason: 'That file is empty.' }
  if (file.size > ATTACHMENT_MAX_UPLOAD_BYTES) {
    const mb = Math.floor(ATTACHMENT_MAX_UPLOAD_BYTES / (1024 * 1024))
    return { ok: false, reason: `Image is too large (max ${mb} MB).` }
  }
  return { ok: true, mime }
}

function isImageCandidate(file: File): boolean {
  return file.type.startsWith('image/') || imageMimeFromFilename(file.name) !== null
}

/** Image files present in a paste's clipboard data (empty → let default paste run). */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f && isImageCandidate(f)) out.push(f)
    }
  }
  return out
}

/** Image files present in a drop's data transfer. */
export function imageFilesFromDrop(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.files).filter(isImageCandidate)
}

export interface AttachmentInsertOpts {
  ownerType: 'note' | 'memo'
  ownerId: string
  onError?: (message: string) => void
}

let previewCounter = 0

interface UploadResponse {
  id: string
  kind: 'image'
  filename: string
  mimeType: string
}

/** Insert one or more image files, each with its own in-flight preview. */
export async function insertImageFiles(
  editor: Editor,
  files: File[],
  opts: AttachmentInsertOpts,
): Promise<void> {
  for (const file of files) {
    const v = validateImageFile(file)
    if (!v.ok) {
      opts.onError?.(v.reason)
      continue
    }

    const tempId = `att-preview-${++previewCounter}`
    const previewUrl = URL.createObjectURL(file)
    editor.commands.addUploadPreview({ id: tempId, previewUrl })

    try {
      // Send the bytes (not a path): a pasted screenshot is an in-memory blob
      // with no filesystem path, so File.arrayBuffer() is the only universal
      // source across paste / drop / file-picker.
      const bytes = new Uint8Array(await file.arrayBuffer())
      const res = await api.invoke<UploadResponse>(IPC_CHANNELS.ATTACHMENT_UPLOAD, {
        ownerType: opts.ownerType,
        ownerId: opts.ownerId,
        filename: file.name || `image.${v.mime.split('/')[1]}`,
        mimeType: v.mime,
        bytes,
      })
      editor.commands.resolveUploadPreview({
        id: tempId,
        src: `cyggie-attachment://${res.id}`,
        alt: res.filename,
      })
    } catch (err) {
      editor.commands.removeUploadPreview({ id: tempId })
      opts.onError?.(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      URL.revokeObjectURL(previewUrl)
    }
  }
}
