// =============================================================================
// attachment.ipc.ts — main-process IPC for note/memo attachments.
//
//   ATTACHMENT_UPLOAD        — read a local file, validate, hash, presign +
//                              PUT to R2, record the synced metadata row, seed
//                              the local cache, return { id, kind, filename, mime }.
//   ATTACHMENT_DELETE        — soft-delete the row (tombstone replicates) + evict
//                              the local cache. R2 byte-reclaim is deferred.
//   ATTACHMENT_OPEN_EXTERNAL — ensure cached, then open in the system viewer
//                              (PDF chips, PR4). Writes an extension-named copy.
//
// Bytes never ride the outbox: only the metadata row syncs (via the withSync
// barrel). The renderer inserts the `cyggie-attachment://{id}` reference ONLY
// after this resolves, so an unconfirmed reference can't reach saved markdown.
// =============================================================================

import { ipcMain, shell } from 'electron'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createId } from '@paralleldrive/cuid2'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { createAttachment, softDeleteAttachment } from '@cyggie/db/sqlite/repositories'
import { getCurrentUserId } from '../security/current-user'
import { requestUploadUrl, putBytes } from '../attachments/attachment-transport'
import {
  writeCached,
  evictCached,
  ensureCached,
  getAttachmentCacheDir,
} from '../attachments/attachment-cache'
import {
  ATTACHMENT_MAX_UPLOAD_BYTES,
  isRasterImageMime,
  imageMimeFromFilename,
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
  kind: 'image'
  filename: string
  mimeType: string
}

export function registerAttachmentHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_UPLOAD,
    async (_event, input: UploadInput): Promise<UploadResult> => {
      const { ownerType, ownerId } = input ?? ({} as UploadInput)
      if (!ownerType || !ownerId || !input?.bytes) {
        throw new Error('ownerType, ownerId, and bytes are required')
      }

      // Re-validate the mime server-side (never trust the renderer): accept the
      // claimed mime only if it's an allowed raster type, else infer from the
      // filename. Reject anything else.
      const mimeType = isRasterImageMime(input.mimeType)
        ? input.mimeType
        : imageMimeFromFilename(input.filename ?? '')
      if (!mimeType) {
        throw new Error('Unsupported file type — images only (png, jpg, gif, webp)')
      }
      const filename = input.filename || `image.${extensionForMime(mimeType)}`

      const bytes = Buffer.from(input.bytes)
      if (bytes.length === 0) throw new Error('File is empty')
      if (bytes.length > ATTACHMENT_MAX_UPLOAD_BYTES) {
        throw new Error(`File too large (max ${ATTACHMENT_MAX_UPLOAD_BYTES} bytes)`)
      }

      const checksum = createHash('sha256').update(bytes).digest('hex')
      const id = createId()
      const userId = getCurrentUserId()

      // 1. Mint a presigned PUT (gateway derives the key from JWT.sub).
      const { url, storageKey } = await requestUploadUrl({
        attachmentId: id,
        contentType: mimeType,
        sizeBytes: bytes.length,
      })

      // 2. PUT bytes straight to R2.
      await putBytes(url, bytes, mimeType)

      // 3. Record the synced metadata row (barrel → outbox). Only AFTER the PUT
      //    succeeds, so a row never points at bytes that aren't in R2.
      let row: ReturnType<typeof createAttachment>
      try {
        row = createAttachment(
          {
            id,
            ownerType,
            ownerId,
            kind: 'image',
            filename,
            mimeType,
            sizeBytes: bytes.length,
            storageKey,
            checksum,
          },
          userId,
        )
      } catch (err) {
        // PUT succeeded but the row write failed → orphaned R2 object. The
        // byte-GC (future) reclaims objects with no row. Surface the failure so
        // the renderer removes the in-flight preview and shows an error.
        console.error(
          `[attachment-upload] createAttachment failed after PUT — R2 object ${storageKey} orphaned`,
          err,
        )
        throw err
      }
      if (!row) throw new Error('Failed to record attachment')

      // 4. Seed the local cache so the just-inserted image renders instantly
      //    (no round-trip through the protocol handler's download path).
      writeCached(id, bytes, { mimeType, checksum, sizeBytes: bytes.length })

      return { id, kind: 'image', filename, mimeType }
    },
  )

  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_DELETE, (_event, input: { id: string }): boolean => {
    if (!input?.id) throw new Error('id is required')
    const userId = getCurrentUserId()
    const row = softDeleteAttachment(input.id, userId)
    evictCached(input.id)
    return Boolean(row)
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
