// =============================================================================
// attachment-upload-drain.ts — the PURE drain core for the attachment byte
// outbox. No Electron / DB runtime imports (type-only), so it's unit-testable.
// The flusher service wires the real dependencies.
// =============================================================================

import type { AttachmentUpload, AttachmentUploadStatus } from '@cyggie/db/sqlite/repositories'

export const MAX_UPLOAD_ATTEMPTS = 5

/** Pure: failed vs dead based on the (incremented) attempt count. */
export function decideUploadStatus(
  attempts: number,
  maxAttempts = MAX_UPLOAD_ATTEMPTS,
): AttachmentUploadStatus {
  return attempts >= maxAttempts ? 'dead' : 'failed'
}

export interface DrainDeps {
  getToken: () => Promise<string | null>
  collectReferenced: () => Set<string>
  listPending: () => AttachmentUpload[]
  readBytes: (attachmentId: string) => Buffer | null
  dropOrphan: (u: AttachmentUpload) => void
  upload: (u: AttachmentUpload, bytes: Buffer) => Promise<void>
  onSuccess: (u: AttachmentUpload) => void
  onFailure: (u: AttachmentUpload, status: AttachmentUploadStatus, err: string) => void
  isAuthError: (err: unknown) => boolean
  maxAttempts: number
}

export interface DrainResult {
  uploaded: number
  dropped: number
  failed: number
  pausedNoAuth: boolean
}

/**
 * Drain pending uploads. Returns counts; never throws. Stops early on an auth
 * error (pause) so we don't hammer a signed-out gateway, and stops the batch on
 * a real failure (the next tick retries 'failed' rows — natural backoff).
 */
export async function drainPendingUploads(deps: DrainDeps): Promise<DrainResult> {
  const res: DrainResult = { uploaded: 0, dropped: 0, failed: 0, pausedNoAuth: false }
  const token = await deps.getToken()
  if (token == null) {
    res.pausedNoAuth = true
    return res
  }
  const referenced = deps.collectReferenced()
  for (const u of deps.listPending()) {
    // Orphan: the image was deleted before it uploaded → never upload it.
    if (!referenced.has(u.attachmentId)) {
      deps.dropOrphan(u)
      res.dropped++
      continue
    }
    const bytes = deps.readBytes(u.attachmentId)
    if (bytes == null) {
      // Bytes vanished (shouldn't happen — eviction protects pending). Without
      // them the upload can never succeed → dead.
      deps.onFailure(u, 'dead', 'cache bytes missing')
      res.failed++
      continue
    }
    try {
      await deps.upload(u, bytes)
      deps.onSuccess(u)
      res.uploaded++
    } catch (err) {
      if (deps.isAuthError(err)) {
        // Token expired mid-drain — pause without penalizing this row.
        res.pausedNoAuth = true
        return res
      }
      const status = decideUploadStatus(u.attempts + 1, deps.maxAttempts)
      deps.onFailure(u, status, err instanceof Error ? err.message : String(err))
      res.failed++
      break
    }
  }
  return res
}
