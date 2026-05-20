// =============================================================================
// pending-upload.ts — MMKV-backed persistence for a failed/in-progress upload.
//
// When stopRecording() fails partway through the upload, the local AAC file
// is intentionally kept on disk (session.ts skips deleteAsync on error). This
// module records WHERE the file is + the metadata needed to retry, so the
// "Retry upload" button on the record screen works after an app restart.
//
// Only one pending upload exists at a time — the user can't be in the middle
// of two recordings simultaneously. Storing a single JSON blob under a fixed
// key is enough.
//
// Cleared on: successful upload, explicit "Cancel" on the error screen.
// =============================================================================

import { appStateStorage } from '../cache/mmkv'

const PENDING_UPLOAD_KEY = 'cyggie.pending-upload.v1'

export interface PendingUpload {
  localUri: string
  /** Optional original title — we may not have one if the user never typed it. */
  title?: string
  calEventId?: string
  /** ISO timestamp when recording started. */
  clientRecordedAt: string
  /** Stored so the UI can show "you have a 3MB unsent recording from 2:14 pm" */
  fileSizeBytes?: number
  /** Last upload attempt's error message, surfaced to the user. */
  lastError?: string
}

export function savePendingUpload(value: PendingUpload): void {
  appStateStorage.set(PENDING_UPLOAD_KEY, JSON.stringify(value))
}

export function loadPendingUpload(): PendingUpload | null {
  const raw = appStateStorage.getString(PENDING_UPLOAD_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PendingUpload
  } catch {
    // Corrupt blob — clear it so the user isn't stuck.
    appStateStorage.delete(PENDING_UPLOAD_KEY)
    return null
  }
}

export function clearPendingUpload(): void {
  appStateStorage.delete(PENDING_UPLOAD_KEY)
}
