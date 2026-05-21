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

export function loadPendingUploadById(clientRecordingId: string): PendingUpload | null {
  const raw = appStateStorage.getString(keyFor(clientRecordingId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PendingUpload
  } catch {
    // Corrupt blob — clear it so it doesn't keep failing parse forever.
    appStateStorage.delete(keyFor(clientRecordingId))
    return null
  }
}

/**
 * Returns all pendingUpload entries, sorted most-recent first by
 * clientRecordedAt. Skips corrupt blobs (also clears them as a side
 * effect). Performs the one-time v1→v2 migration on each call
 * (idempotent — does nothing once the legacy slot is empty).
 */
export function loadAllPendingUploads(): PendingUpload[] {
  migrateLegacyEntry()
  const keys = appStateStorage.getAllKeys().filter((k) => k.startsWith(KEY_PREFIX))
  const out: PendingUpload[] = []
  for (const key of keys) {
    const raw = appStateStorage.getString(key)
    if (!raw) continue
    try {
      out.push(JSON.parse(raw) as PendingUpload)
    } catch {
      appStateStorage.delete(key)
    }
  }
  return out.sort((a, b) => (a.clientRecordedAt > b.clientRecordedAt ? -1 : 1))
}

export function loadPendingUploadByMeetingId(meetingId: string): PendingUpload | null {
  return loadAllPendingUploads().find((p) => p.meetingId === meetingId) ?? null
}

export function clearPendingUploadById(clientRecordingId: string): void {
  appStateStorage.delete(keyFor(clientRecordingId))
}

/**
 * Best-effort delete the local audio file + clear the MMKV slot for a
 * specific recording. Safe to call when the file or slot is already gone
 * (idempotent no-op).
 */
export async function discardPendingUploadFileById(clientRecordingId: string): Promise<void> {
  const entry = loadPendingUploadById(clientRecordingId)
  if (entry?.localUri) {
    try {
      await FileSystem.deleteAsync(entry.localUri, { idempotent: true })
    } catch {
      // Best-effort — iOS cache will GC eventually.
    }
  }
  clearPendingUploadById(clientRecordingId)
}

/** Same as discardPendingUploadFileById but looks up the entry by meetingId. */
export async function discardPendingUploadFileByMeetingId(meetingId: string): Promise<void> {
  const entry = loadPendingUploadByMeetingId(meetingId)
  if (!entry) return
  await discardPendingUploadFileById(entry.clientRecordingId)
}

/**
 * Load the most-recent pending upload (by clientRecordedAt), evicting any
 * entries older than `maxAgeMs` first. Used on /record cold-start to
 * decide whether to re-attach a poll, surface a retry UI, or start a
 * fresh recording.
 *
 * Returns null in the no-entry, all-stale, or just-evicted-most-recent
 * cases — callers treat them identically.
 *
 * Note: eviction is a full pass over ALL entries, not just the most
 * recent — so old stale entries get cleaned up even when there's a
 * fresher one to return.
 */
export async function loadMostRecentPendingUploadOrEvict(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<PendingUpload | null> {
  const all = loadAllPendingUploads()
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
 * key is empty. Assigns a freshly-generated clientRecordingId.
 *
 * Exported so the rewriting tests can call it directly without relying
 * on a side-effect through loadAllPendingUploads.
 */
export function migrateLegacyEntry(): void {
  const raw = appStateStorage.getString(LEGACY_KEY)
  if (!raw) return
  try {
    const legacy = JSON.parse(raw) as Omit<PendingUpload, 'clientRecordingId'>
    if (legacy && typeof legacy === 'object' && typeof legacy.localUri === 'string') {
      savePendingUpload({ ...legacy, clientRecordingId: generateClientRecordingId() })
    }
  } catch {
    // Malformed legacy blob — drop it rather than carry corruption forward.
  }
  appStateStorage.delete(LEGACY_KEY)
}
