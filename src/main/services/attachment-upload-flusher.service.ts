// =============================================================================
// attachment-upload-flusher.service.ts — the background drain for the local
// "byte outbox" (attachment_uploads). Mirrors the SyncAgent: a 5s tick + an
// immediate flush on start / sign-in, auth-gated, with retry→dead.
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ not signed in        → pause (leave queued)                       │
//   │ id no longer in any   → drop (evict cache + delete row) — never    │
//   │   note/memo content       upload an orphan                         │
//   │ else                  → presign PUT → PUT bytes → createAttachment  │
//   │                          (syncs the metadata row) → delete queue row│
//   │ failure               → attempts++ ; status failed→dead at MAX     │
//   │                          (image still renders locally from cache)   │
//   └──────────────────────────────────────────────────────────────────┘
//
// Bytes live in the local attachment-cache (the queue's backing store), which
// the size-cap eviction protects while an upload is pending.
// =============================================================================

import {
  listPendingUploads,
  deleteUpload,
  deleteUploadByAttachmentId,
  markUploadResult,
  collectReferencedAttachmentIds,
  createAttachment,
} from '@cyggie/db/sqlite/repositories'
import { getAccessToken } from '../auth/cyggie-auth'
import { getCurrentUserId } from '../security/current-user'
import { readCached, evictCached } from '../attachments/attachment-cache'
import {
  requestUploadUrl,
  putBytes,
  AttachmentAuthError,
} from '../attachments/attachment-transport'
import { drainPendingUploads, MAX_UPLOAD_ATTEMPTS, type DrainDeps } from './attachment-upload-drain'

const TICK_INTERVAL_MS = 5_000
const BATCH_SIZE = 10

// ─── Real wiring ─────────────────────────────────────────────────────────────

let running = false
let tickHandle: ReturnType<typeof setInterval> | null = null
let flushing = false

function realDeps(): DrainDeps {
  return {
    getToken: getAccessToken,
    collectReferenced: collectReferencedAttachmentIds,
    listPending: () => listPendingUploads(BATCH_SIZE),
    readBytes: (id) => readCached(id)?.bytes ?? null,
    dropOrphan: (u) => {
      evictCached(u.attachmentId)
      deleteUploadByAttachmentId(u.attachmentId)
    },
    upload: async (u, bytes) => {
      const { url, storageKey } = await requestUploadUrl({
        attachmentId: u.attachmentId,
        contentType: u.mimeType,
        sizeBytes: u.sizeBytes,
      })
      await putBytes(url, bytes, u.mimeType)
      // Create the SYNCED metadata row now (signed in → withSync emits the
      // outbox entry). storageKey is authoritative (gateway-derived from JWT.sub).
      const userId = u.userId ?? getCurrentUserId()
      const row = createAttachment(
        {
          id: u.attachmentId,
          ownerType: u.ownerType as 'note' | 'memo',
          ownerId: u.ownerId,
          kind: 'image',
          filename: u.filename,
          mimeType: u.mimeType,
          sizeBytes: u.sizeBytes,
          storageKey,
          checksum: u.checksum,
        },
        userId,
      )
      if (!row) throw new Error('createAttachment returned null')
    },
    onSuccess: (u) => deleteUpload(u.id),
    onFailure: (u, status, err) => markUploadResult(u.id, status, err),
    isAuthError: (err) => err instanceof AttachmentAuthError,
    maxAttempts: MAX_UPLOAD_ATTEMPTS,
  }
}

async function flushOnce(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const r = await drainPendingUploads(realDeps())
    if (r.uploaded > 0 || r.dropped > 0 || r.failed > 0) {
      console.log(
        `[attachment-upload] flush uploaded=${r.uploaded} dropped=${r.dropped} failed=${r.failed} ` +
          `metric=attachment.upload.flush`,
      )
    }
  } catch (err) {
    console.error('[attachment-upload] flush failed:', err)
  } finally {
    flushing = false
  }
}

export function startAttachmentUploadFlusher(): void {
  if (running) return
  running = true
  tickHandle = setInterval(() => void flushOnce(), TICK_INTERVAL_MS)
  tickHandle.unref?.()
  void flushOnce()
}

export function stopAttachmentUploadFlusher(): void {
  running = false
  if (tickHandle) {
    clearInterval(tickHandle)
    tickHandle = null
  }
}

/** Nudge an immediate flush (paste, sign-in). No-op if not started/running. */
export function triggerAttachmentUploadFlush(): void {
  if (!running) return
  void flushOnce()
}
