import { join } from 'path'
import { existsSync } from 'fs'
import {
  getStoragePath,
  getPrivateRoot,
  getSharedRoot,
  getTranscriptsDir,
  getSummariesDir,
  getRecordingsDir,
  getMemosDir,
} from './paths'

// ─────────────────────────────────────────────────────────────────────────────
// File routing by is_private (two-tier storage, Slice 3).
//
//   FLAG OFF (default) ─▶ every file uses the single storagePath (today's behavior)
//   FLAG ON:
//     is_private === false (public) ─▶ SHARED root (Drive) — or HOLD if unresolved (3A)
//     anything else        (private) ─▶ PRIVATE root (local)   ← fail-closed
//
// "anything else" is deliberate: a null/undefined is_private (couldn't determine)
// routes PRIVATE, never leaking to the shared folder. Public requires an explicit
// `false`. The single source of truth for "which root" is rootForMeeting(); every
// write/read/relocate site delegates here (no scattered ternaries).
// ─────────────────────────────────────────────────────────────────────────────

export type StorageKind = 'transcript' | 'summary' | 'recording' | 'memo'

/** Feature flag. Slice 3b wires this to a setting; default OFF keeps legacy
 *  single-root behavior so a half-rolled-out fleet stays correct. */
let flagOverride: boolean | null = null
export function __setTwoTierFlagForTests(v: boolean | null): void {
  flagOverride = v
}
export function isTwoTierStorageEnabled(): boolean {
  if (flagOverride !== null) return flagOverride
  return process.env['CYGGIE_TWO_TIER_STORAGE'] === '1'
}

export type RouteResult =
  | { kind: 'root'; root: string }
  | { kind: 'hold'; reason: 'shared-unresolved' }

interface MeetingPrivacy {
  isPrivate?: boolean | null
}

/** Public only when is_private is explicitly false; everything else is private
 *  (fail-closed — never leak an unknown-privacy file to the shared folder). */
function isPublic(meeting: MeetingPrivacy): boolean {
  return meeting.isPrivate === false
}

/**
 * The single source of truth for "which root does this meeting's files use".
 * Public files need the shared root; if it isn't resolved yet, return a HOLD so
 * the finalize path keeps the file in local staging + surfaces a banner (3A)
 * instead of silently mis-filing it locally.
 */
export function rootForMeeting(meeting: MeetingPrivacy): RouteResult {
  if (!isTwoTierStorageEnabled()) {
    return { kind: 'root', root: getStoragePath() }
  }
  if (!isPublic(meeting)) {
    return { kind: 'root', root: getPrivateRoot() }
  }
  const shared = getSharedRoot()
  if (shared == null) return { kind: 'hold', reason: 'shared-unresolved' }
  return { kind: 'root', root: shared }
}

function dirFor(kind: StorageKind, root: string): string {
  switch (kind) {
    case 'transcript':
      return getTranscriptsDir(root)
    case 'summary':
      return getSummariesDir(root)
    case 'recording':
      return getRecordingsDir(root)
    case 'memo':
      return getMemosDir(root)
  }
}

// Per-(meeting,kind,filename) resolution cache (Issue 4A) so the common file-open
// never re-stats a slow Drive online-only path. Cleared when a file relocates.
const resolveCache = new Map<string, string>()

function cacheKey(meetingId: string, kind: StorageKind, filename: string): string {
  return `${meetingId}|${kind}|${filename}`
}

/** Drop cached resolutions for a meeting (call after a relocation toggles roots). */
export function invalidateResolveCache(meetingId: string): void {
  const prefix = `${meetingId}|`
  for (const k of resolveCache.keys()) {
    if (k.startsWith(prefix)) resolveCache.delete(k)
  }
}

/** Test-only full reset. */
export function __resetResolveCacheForTests(): void {
  resolveCache.clear()
}

/**
 * Locate an existing file across the two roots. Checks the is_private-implied
 * root FIRST (so the common case never stats the other — possibly Drive online-
 * only — path), falls back to the other root only on a miss, and caches the hit.
 * Returns the absolute path, or null if the file is in neither root.
 *
 * Flag OFF → single-root lookup (today's behavior).
 */
export function resolveExistingFile(
  meeting: MeetingPrivacy & { id: string },
  kind: StorageKind,
  filename: string,
): string | null {
  if (!filename) return null

  const key = cacheKey(meeting.id, kind, filename)
  const cached = resolveCache.get(key)
  if (cached && existsSync(cached)) return cached
  if (cached) resolveCache.delete(key) // stale (file moved/deleted) — re-resolve

  if (!isTwoTierStorageEnabled()) {
    const p = join(dirFor(kind, getStoragePath()), filename)
    return existsSync(p) ? p : null
  }

  // Ordered roots: implied first, then the other (skip a null shared root).
  const privateRoot = getPrivateRoot()
  const shared = getSharedRoot()
  const ordered = isPublic(meeting)
    ? [shared, privateRoot]
    : [privateRoot, shared]

  for (const root of ordered) {
    if (root == null) continue
    const p = join(dirFor(kind, root), filename)
    if (existsSync(p)) {
      resolveCache.set(key, p)
      return p
    }
  }
  return null
}
