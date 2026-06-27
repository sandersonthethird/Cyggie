// =============================================================================
// attachment.ipc.ts — main-process IPC for note/memo attachments.
//
//   ATTACHMENT_UPLOAD        — validate + hash + write the bytes to the LOCAL
//                              cache + enqueue a background upload, then return
//                              instantly. NO network — paste never blocks or
//                              errors on auth. The flusher uploads + creates the
//                              synced metadata row later (mirrors how a note
//                              write lands in SQLite + syncs via the outbox).
//   ATTACHMENT_DELETE        — drop the pending upload (if any) + soft-delete the
//                              row (if any) + evict the cache. Robust to delete-
//                              before-upload.
//   ATTACHMENT_OPEN_EXTERNAL — ensure cached, then open in the system viewer
//                              (PDF chips, PR4). Writes an extension-named copy.
//
// Bytes never ride the sync outbox: the byte queue (attachment_uploads) carries
// them to object storage; only the small metadata row syncs.
// =============================================================================

import { ipcMain, shell } from 'electron'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createId } from '@paralleldrive/cuid2'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  enqueueUpload,
  deleteUploadByAttachmentId,
  getAttachment,
  softDeleteAttachment,
  type AttachmentKind,
} from '@cyggie/db/sqlite/repositories'
import { getCurrentUserId } from '../security/current-user'
import { triggerAttachmentUploadFlush } from '../services/attachment-upload-flusher.service'
import {
  writeCached,
  evictCached,
  ensureCached,
  getAttachmentCacheDir,
} from '../attachments/attachment-cache'
import {
  ATTACHMENT_MAX_UPLOAD_BYTES,
  isRasterImageMime,
  isPdfMime,
  imageMimeFromFilename,
  pdfMimeFromFilename,
  extensionForMime,
} from '../../shared/attachments'

interface UploadInput {
  ownerType: 'note' | 'memo'
  ownerId: string
  // Bytes (not a path): a pasted screenshot has no filesystem path.
  bytes: Uint8Array
  filename: string
  mimeType: string
}

export interface UploadResult {
  id: string
  kind: AttachmentKind
  filename: string
  mimeType: string
}

export function registerAttachmentHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_UPLOAD,
    (_event, input: UploadInput): UploadResult => {
      const { ownerType, ownerId } = input ?? ({} as UploadInput)
      if (!ownerType || !ownerId || !input?.bytes) {
        throw new Error('ownerType, ownerId, and bytes are required')
      }

      // Re-validate the mime server-side (never trust the renderer): accept a
      // raster image OR a PDF — by the claimed mime, else inferred from the
      // filename. Reject anything else.
      const claimed = input.mimeType ?? ''
      const fname = input.filename ?? ''
      const mimeType =
        isRasterImageMime(claimed) || isPdfMime(claimed)
          ? claimed
          : imageMimeFromFilename(fname) ?? pdfMimeFromFilename(fname)
      if (!mimeType) {
        throw new Error('Unsupported file type — images (png, jpg, gif, webp) or PDF')
      }
      const kind: AttachmentKind = isPdfMime(mimeType) ? 'pdf' : 'image'
      const filename =
        input.filename || `${kind === 'pdf' ? 'document' : 'image'}.${extensionForMime(mimeType)}`

      const bytes = Buffer.from(input.bytes)
      if (bytes.length === 0) throw new Error('File is empty')
      if (bytes.length > ATTACHMENT_MAX_UPLOAD_BYTES) {
        throw new Error(`File too large (max ${ATTACHMENT_MAX_UPLOAD_BYTES} bytes)`)
      }

      const checksum = createHash('sha256').update(bytes).digest('hex')
      const id = createId()
      const userId = getCurrentUserId()

      // 1. Write bytes to the local cache so the attachment renders instantly +
      //    the flusher has its source (the cache is the byte queue's backing store).
      writeCached(id, bytes, { mimeType, checksum, sizeBytes: bytes.length })

      // 2. Enqueue the background upload. No network here — returns immediately,
      //    so paste never blocks and never errors when signed out / offline.
      enqueueUpload({
        attachmentId: id,
        userId,
        ownerType,
        ownerId,
        kind,
        filename,
        mimeType,
        sizeBytes: bytes.length,
        checksum,
      })

      // 3. Nudge the flusher (no-op if not signed in — it stays queued).
      triggerAttachmentUploadFlush()

      return { id, kind, filename, mimeType }
    },
  )

  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_DELETE, (_event, input: { id: string }): boolean => {
    if (!input?.id) throw new Error('id is required')
    const userId = getCurrentUserId()
    // Drop a not-yet-uploaded queue row (delete-before-upload) AND soft-delete a
    // synced row if the flusher already created one. Either may be absent.
    deleteUploadByAttachmentId(input.id)
    const existed = getAttachment(input.id) != null
    if (existed) softDeleteAttachment(input.id, userId)
    evictCached(input.id)
    return existed
  })

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_OPEN_EXTERNAL,
    async (_event, input: { id: string }): Promise<boolean> => {
      if (!input?.id) throw new Error('id is required')
      const result = await ensureCached(input.id)
      if (!result) return false
      // shell.openPath uses the file extension to pick an app, but cache files
      // are extension-less — write an extension-named copy next to it.
      const ext = extensionForMime(result.meta.mimeType)
      const openPath = join(getAttachmentCacheDir(), `${input.id}.open.${ext}`)
      if (!existsSync(openPath)) writeFileSync(openPath, result.bytes)
      const err = await shell.openPath(openPath)
      return err === ''
    },
  )
}
