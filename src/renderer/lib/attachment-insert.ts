// =============================================================================
// attachment-insert.ts — renderer orchestration for inserting attachments
// (images + PDFs) into a Tiptap editor.
//
//   pick/paste/drop File → validate → decoration preview (instant) →
//   ATTACHMENT_UPLOAD IPC → on success swap the preview for a real node
//   (Image for images, PdfAttachment for PDFs, both `cyggie-attachment://{id}`);
//   on failure drop the preview.
//
// Images and PDFs share ONE orchestration core (`insertAttachmentFiles`); they
// differ only in the validate ruleset, the preview chrome, and which node the
// resolved upload becomes. See attachment-upload-extension.ts for why the
// reference only reaches the document (and thus autosave) after the upload IPC.
// =============================================================================

import type { Editor } from '@tiptap/react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  ATTACHMENT_MAX_UPLOAD_BYTES,
  isRasterImageMime,
  isPdfMime,
  imageMimeFromFilename,
  pdfMimeFromFilename,
  PDF_MIME,
} from '../../shared/attachments'

export type AttachmentValidation = { ok: true; mime: string } | { ok: false; reason: string }
/** @deprecated kept for back-compat; use AttachmentValidation. */
export type ImageFileValidation = AttachmentValidation

type FileMeta = { name: string; type: string; size: number }

function tooLargeReason(noun: string): string {
  const mb = Math.floor(ATTACHMENT_MAX_UPLOAD_BYTES / (1024 * 1024))
  return `${noun} is too large (max ${mb} MB).`
}

/** PURE: validate a candidate image file (mime + non-empty + under the cap). */
export function validateImageFile(file: FileMeta): AttachmentValidation {
  const mime = isRasterImageMime(file.type) ? file.type : imageMimeFromFilename(file.name)
  if (!mime) return { ok: false, reason: 'Only PNG, JPG, GIF, or WebP images are supported.' }
  if (file.size === 0) return { ok: false, reason: 'That file is empty.' }
  if (file.size > ATTACHMENT_MAX_UPLOAD_BYTES) return { ok: false, reason: tooLargeReason('Image') }
  return { ok: true, mime }
}

/** PURE: validate a candidate PDF file (mime/extension + non-empty + under the cap). */
export function validatePdfFile(file: FileMeta): AttachmentValidation {
  const mime = isPdfMime(file.type) ? PDF_MIME : pdfMimeFromFilename(file.name)
  if (!mime) return { ok: false, reason: 'Only PDF files are supported here.' }
  if (file.size === 0) return { ok: false, reason: 'That file is empty.' }
  if (file.size > ATTACHMENT_MAX_UPLOAD_BYTES) return { ok: false, reason: tooLargeReason('PDF') }
  return { ok: true, mime }
}

export function isImageCandidate(file: File): boolean {
  return file.type.startsWith('image/') || imageMimeFromFilename(file.name) !== null
}

export function isPdfCandidate(file: File): boolean {
  return isPdfMime(file.type) || pdfMimeFromFilename(file.name) !== null
}

function filesFromClipboard(data: DataTransfer | null, pred: (f: File) => boolean): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f && pred(f)) out.push(f)
    }
  }
  return out
}

/** Image files present in a paste (empty → let default paste run). */
export const imageFilesFromClipboard = (d: DataTransfer | null): File[] =>
  filesFromClipboard(d, isImageCandidate)
/** PDF files present in a paste. */
export const pdfFilesFromClipboard = (d: DataTransfer | null): File[] =>
  filesFromClipboard(d, isPdfCandidate)

/** Image files present in a drop. */
export const imageFilesFromDrop = (d: DataTransfer | null): File[] =>
  d ? Array.from(d.files).filter(isImageCandidate) : []
/** PDF files present in a drop. */
export const pdfFilesFromDrop = (d: DataTransfer | null): File[] =>
  d ? Array.from(d.files).filter(isPdfCandidate) : []

export interface AttachmentInsertOpts {
  ownerType: 'note' | 'memo'
  ownerId: string
  onError?: (message: string) => void
}

interface UploadResponse {
  id: string
  kind: 'image' | 'pdf'
  filename: string
  mimeType: string
}

// Per-kind hooks for the shared orchestration core.
interface AttachmentKindSpec {
  validate: (file: FileMeta) => AttachmentValidation
  /** Instant in-flight preview chrome: a blob thumbnail (image) or a label (pdf). */
  preview: (file: File) => { previewUrl?: string; label?: string }
  /** Swap the resolved upload into the real editor node. */
  resolve: (editor: Editor, tempId: string, res: UploadResponse) => void
}

let previewCounter = 0

/** Shared core: validate → preview → upload → resolve, one file at a time. */
async function insertAttachmentFiles(
  editor: Editor,
  files: File[],
  opts: AttachmentInsertOpts,
  spec: AttachmentKindSpec,
): Promise<void> {
  for (const file of files) {
    const v = spec.validate(file)
    if (!v.ok) {
      opts.onError?.(v.reason)
      continue
    }

    const tempId = `att-preview-${++previewCounter}`
    const preview = spec.preview(file)
    editor.commands.addUploadPreview({ id: tempId, previewUrl: preview.previewUrl, label: preview.label })

    try {
      // Send the bytes (not a path): a pasted blob has no filesystem path, so
      // File.arrayBuffer() is the only universal source across paste/drop/picker.
      const bytes = new Uint8Array(await file.arrayBuffer())
      const res = await api.invoke<UploadResponse>(IPC_CHANNELS.ATTACHMENT_UPLOAD, {
        ownerType: opts.ownerType,
        ownerId: opts.ownerId,
        filename: file.name || `attachment.${v.mime.split('/')[1]}`,
        mimeType: v.mime,
        bytes,
      })
      spec.resolve(editor, tempId, res)
    } catch (err) {
      editor.commands.removeUploadPreview({ id: tempId })
      opts.onError?.(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      if (preview.previewUrl) URL.revokeObjectURL(preview.previewUrl)
    }
  }
}

/** Insert one or more IMAGE files, each with its own in-flight blob preview. */
export function insertImageFiles(editor: Editor, files: File[], opts: AttachmentInsertOpts): Promise<void> {
  return insertAttachmentFiles(editor, files, opts, {
    validate: validateImageFile,
    preview: (file) => ({ previewUrl: URL.createObjectURL(file) }),
    resolve: (ed, tempId, res) =>
      ed.commands.resolveUploadPreview({
        id: tempId,
        src: `cyggie-attachment://${res.id}`,
        alt: res.filename,
      }),
  })
}

/** Insert one or more PDF files, each with its own in-flight label preview. */
export function insertPdfFiles(editor: Editor, files: File[], opts: AttachmentInsertOpts): Promise<void> {
  return insertAttachmentFiles(editor, files, opts, {
    validate: validatePdfFile,
    preview: () => ({ label: 'Adding PDF…' }),
    resolve: (ed, tempId, res) =>
      ed.commands.resolvePdfPreview({ id: tempId, attachmentId: res.id, name: res.filename }),
  })
}
