// =============================================================================
// pending-upload.ts — MMKV-backed persistence for recordings in flight.
//
// Multi-slot: each recording owns its own MMKV entry keyed by a
// client-generated `clientRecordingId` (set at recording start). This lets
// multiple in-flight transcriptions coexist — the user can stop one
// recording (which goes into the server-side transcribe queue) and
// immediately start a new one without losing the older audio file or its
// retry-upload safety net.
//
// Lifecycle (per recording):
//
//   recording finished
//        │  stopRecording → performUpload(p)
//        ▼
//   awaiting_upload  (slot created, no meetingId, audio on disk)
//        │  upload-success: set meetingId, KEEP audio on disk
//        ▼
//   awaiting_transcription  (meetingId stored, audio on disk)
//        │  /record poll OR meeting-detail side-effect detects terminal
//        ▼
//   discardPendingUploadFileByMeetingId(meetingId)
//        │  → FileSystem.deleteAsync(localUri) + slot removed
//        ▼
//   gone (only this recording's slot; other slots untouched)
//
// Storage layout in MMKV (single appStateStorage instance):
//   cyggie.pending-upload.v2:<clientRecordingId>  →  PendingUpload JSON
//   cyggie.pending-upload.v1                       →  legacy single-slot,
//                                                     migrated on first
//                                                     v2 read
//
// Discovery: appStateStorage.getAllKeys() filtered by the v2 prefix —
// no separate index needed.
//
// User scoping: every entry carries the userId of the recorder. Load
// functions take the current userId and filter — prevents user B from
// seeing user A's pending recording after a sign-out / sign-in on the
// same device. Pre-scope entries (no userId) are treated as orphans and
// evicted on first load.
// =============================================================================

import * as FileSystem from 'expo-file-system/legacy'
import { appStateStorage } from '../cache/mmkv'

const KEY_PREFIX = 'cyggie.pending-upload.v2:'
const LEGACY_KEY = 'cyggie.pending-upload.v1'

/**
 * Eviction window: drop pendingUpload entries older than this. Protects
 * against orphan audio files accumulating if server-side state is
 * permanently broken or the user forgot they had a pending recording.
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface PendingUpload {
  /**
   * Stable client-generated ID set at recording start. Survives across
   * upload, transcription, and retry — the MMKV slot key is derived from
   * this so multiple recordings can be tracked simultaneously without
   * clobbering each other.
   */
  clientRecordingId: string
  /**
   * userId of the partner who started the recording. Stamped at recording
   * start; load functions filter by current userId so a sign-out/sign-in
   * as a different user on the same device doesn't surface another
   * user's pending recording.
   */
  userId: string
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

/**
 * Lightweight unique-id generator. Timestamp + random suffix is plenty
 * for collision avoidance on a single device — no external uuid dep.
 */
export function generateClientRecordingId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function keyFor(clientRecordingId: string): string {
  return KEY_PREFIX + clientRecordingId
}

export function savePendingUpload(p: PendingUpload): void {
  appStateStorage.set(keyFor(p.clientRecordingId), JSON.stringify(p))
}

/**
 * Load a specific entry by clientRecordingId, filtered by current userId.
 * Returns null when no entry exists OR when the entry belongs to a
 * different user (cross-user isolation — see file header).
 */
export function loadPendingUploadById(
  clientRecordingId: string,
  userId: string,
): PendingUpload | null {
  const raw = appStateStorage.getString(keyFor(clientRecordingId))
  if (!raw) return null
  try {
    const entry = JSON.parse(raw) as PendingUpload
    if (entry.userId !== userId) return null
    return entry
  } catch {
    // Corrupt blob — clear it so it doesn't keep failing parse forever.
    appStateStorage.delete(keyFor(clientRecordingId))
    return null
  }
}

/**
 * Returns all pendingUpload entries belonging to `userId`, sorted
 * most-recent first by clientRecordedAt. Skips corrupt blobs and
 * entries owned by other users (also evicts pre-scope entries that
 * lack a userId — they're orphans from the pre-1A code). Performs
 * the one-time v1→v2 migration on each call (idempotent once the
 * legacy slot is empty).
 */
export function loadAllPendingUploads(userId: string): PendingUpload[] {
  migrateLegacyEntry(userId)
  const keys = appStateStorage.getAllKeys().filter((k) => k.startsWith(KEY_PREFIX))
  const out: PendingUpload[] = []
  for (const key of keys) {
    const raw = appStateStorage.getString(key)
    if (!raw) continue
    try {
      const entry = JSON.parse(raw) as PendingUpload
      // Pre-1A entries lack userId — evict as orphans (audio file
      // becomes unreachable, but the user is signed in as a different
      // identity than the one that recorded it OR the entry predates
      // user scoping entirely; either way, it's not addressable).
      if (!entry.userId) {
        appStateStorage.delete(key)
        continue
      }
      if (entry.userId !== userId) continue
      out.push(entry)
    } catch {
      appStateStorage.delete(key)
    }
  }
  return out.sort((a, b) => (a.clientRecordedAt > b.clientRecordedAt ? -1 : 1))
}

export function loadPendingUploadByMeetingId(
  meetingId: string,
  userId: string,
): PendingUpload | null {
  return loadAllPendingUploads(userId).find((p) => p.meetingId === meetingId) ?? null
}

export function clearPendingUploadById(clientRecordingId: string): void {
  appStateStorage.delete(keyFor(clientRecordingId))
}

/**
 * Best-effort delete the local audio file + clear the MMKV slot for a
 * specific recording. Safe to call when the file or slot is already gone
 * (idempotent no-op).
 *
 * Bypasses the userId filter intentionally: this is a stable-key cleanup
 * (the caller already holds the clientRecordingId, which is random and
 * doesn't leak cross-user content). Used by both user-initiated discards
 * and the eviction path inside loadMostRecentPendingUploadOrEvict.
 */
export async function discardPendingUploadFileById(clientRecordingId: string): Promise<void> {
  const raw = appStateStorage.getString(keyFor(clientRecordingId))
  if (raw) {
    try {
      const entry = JSON.parse(raw) as PendingUpload
      if (entry.localUri) {
        try {
          await FileSystem.deleteAsync(entry.localUri, { idempotent: true })
        } catch {
          // Best-effort — iOS cache will GC eventually.
        }
      }
    } catch {
      // malformed blob — fall through and clear the slot
    }
  }
  clearPendingUploadById(clientRecordingId)
}

/** Same as discardPendingUploadFileById but looks up the entry by meetingId. */
export async function discardPendingUploadFileByMeetingId(
  meetingId: string,
  userId: string,
): Promise<void> {
  const entry = loadPendingUploadByMeetingId(meetingId, userId)
  if (!entry) return
  await discardPendingUploadFileById(entry.clientRecordingId)
}

/**
 * Load the most-recent pending upload (by clientRecordedAt) for `userId`,
 * evicting any entries older than `maxAgeMs` first. Used on /record
 * cold-start to decide whether to re-attach a poll, surface a retry UI,
 * or start a fresh recording.
 *
 * Returns null in the no-entry, all-stale, or just-evicted-most-recent
 * cases — callers treat them identically.
 *
 * Note: eviction is a full pass over the current user's entries — so
 * old stale entries get cleaned up even when there's a fresher one to
 * return. Other users' entries are filtered upstream by
 * loadAllPendingUploads.
 */
export async function loadMostRecentPendingUploadOrEvict(
  userId: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<PendingUpload | null> {
  const all = loadAllPendingUploads(userId)
  if (all.length === 0) return null
  const survivors: PendingUpload[] = []
  for (const entry of all) {
    const ageMs = Date.now() - new Date(entry.clientRecordedAt).getTime()
    if (!Number.isFinite(ageMs) || ageMs >= maxAgeMs) {
      await discardPendingUploadFileById(entry.clientRecordingId)
    } else {
      survivors.push(entry)
    }
  }
  return survivors[0] ?? null
}

/**
 * One-time copy of any v1 single-slot entry into a v2 keyed slot. Runs
 * inline on every loadAllPendingUploads call; idempotent once the legacy
 * key is empty. Assigns a freshly-generated clientRecordingId and stamps
 * the current `userId` (v1 entries predate user scoping; the single-slot
 * design implied "the device's current user," so we adopt that).
 *
 * Exported so the rewriting tests can call it directly without relying
 * on a side-effect through loadAllPendingUploads.
 */
export function migrateLegacyEntry(userId: string): void {
  const raw = appStateStorage.getString(LEGACY_KEY)
  if (!raw) return
  try {
    const legacy = JSON.parse(raw) as Omit<PendingUpload, 'clientRecordingId' | 'userId'>
    if (legacy && typeof legacy === 'object' && typeof legacy.localUri === 'string') {
      savePendingUpload({
        ...legacy,
        clientRecordingId: generateClientRecordingId(),
        userId,
      })
    }
  } catch {
    // Malformed legacy blob — drop it rather than carry corruption forward.
  }
  appStateStorage.delete(LEGACY_KEY)
}
