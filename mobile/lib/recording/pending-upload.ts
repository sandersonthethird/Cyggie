// =============================================================================
// pending-upload.ts — MMKV-backed persistence for a recording in flight.
//
// Lifecycle (post phone-side-retention):
//
//   recording finished
//        │  stopRecording → performUpload
//        ▼
//   awaiting_upload  (no meetingId, audio on disk)
//        │  upload-success: set meetingId, KEEP audio on disk
//        ▼
//   awaiting_transcription  (meetingId present, audio on disk)
//        │  poll detects status='transcribed' or 'empty'
//        │  → FileSystem.deleteAsync(localUri) + clearPendingUpload()
//        ▼
//   gone
//
// Why the audio survives upload-success: if the gateway later sets
// status='error' (Deepgram callback returned a failure variant, etc.) we
// can re-upload from the local file rather than losing the recording.
// See use-transcribing-poll.ts for the cleanup + retry promotion logic.
//
// Only one pending recording exists at a time — the user can't be in the
// middle of two recordings simultaneously. Storing a single JSON blob
// under a fixed key is enough.
// =============================================================================

import * as FileSystem from 'expo-file-system/legacy'
import { appStateStorage } from '../cache/mmkv'

const PENDING_UPLOAD_KEY = 'cyggie.pending-upload.v1'

/**
 * Eviction window: drop pendingUpload entries older than this. Prevents
 * orphan audio files from accumulating if server-side state is permanently
 * broken (no transcription callback ever arrives, no error status set,
 * user forgot they had a pending recording).
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
  /**
   * Server-assigned meeting id. Presence transitions the entry from
   * `awaiting_upload` (no meetingId) to `awaiting_transcription`
   * (meetingId present). The poll cleanup checks for this to know
   * whether to navigate / clean up the local file once a terminal
   * status arrives.
   */
  meetingId?: string
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

/**
 * Load the pending upload, but evict (delete file + clear MMKV) if its
 * `clientRecordedAt` is older than `maxAgeMs`. Centralizes the eviction
 * policy so call sites that load the pending entry get the same behavior.
 *
 * Returns null in both the no-entry and just-evicted cases — the caller
 * treats them identically.
 */
export async function loadPendingUploadOrEvict(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<PendingUpload | null> {
  const entry = loadPendingUpload()
  if (!entry) return null
  const ageMs = Date.now() - new Date(entry.clientRecordedAt).getTime()
  // Guard against malformed timestamps (NaN comparisons are always false)
  // by also checking the upper bound — if Date.parse fails, age is NaN.
  if (!Number.isFinite(ageMs) || ageMs >= maxAgeMs) {
    try {
      await FileSystem.deleteAsync(entry.localUri, { idempotent: true })
    } catch {
      // Best-effort — even if the file is unreachable, clear MMKV so the
      // user isn't stuck staring at a stale pending entry forever.
    }
    clearPendingUpload()
    return null
  }
  return entry
}
