import { join, normalize } from 'path'
import { existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'fs'
import {
  getStoragePath,
  getPrivateRoot,
  getSharedRoot,
  getStagingDir,
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

// Feature flag. Resolution order (first decisive wins):
//   1. test override (__setTwoTierFlagForTests) — non-null forces a value
//   2. env CYGGIE_TWO_TIER_STORAGE=1 — manual/dev opt-in
//   3. injected setting provider (Slice 3b) — reads the `twoTierStorageEnabled`
//      setting; injected from the main layer so routing stays db-dependency-free
//      (keeps the storage unit tests from needing a built better-sqlite3).
// Default OFF keeps legacy single-root behavior so a half-rolled-out fleet stays
// correct.
let flagOverride: boolean | null = null
let settingProvider: (() => boolean) | null = null

export function __setTwoTierFlagForTests(v: boolean | null): void {
  flagOverride = v
}

/** Inject the setting-backed flag reader (Slice 3b). Pass null to clear. */
export function setTwoTierSettingProvider(fn: (() => boolean) | null): void {
  settingProvider = fn
}

export function isTwoTierStorageEnabled(): boolean {
  if (flagOverride !== null) return flagOverride
  if (process.env['CYGGIE_TWO_TIER_STORAGE'] === '1') return true
  return settingProvider ? settingProvider() : false
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

/**
 * Ordered recording directories the media:// handler and filename-resolvers
 * probe when they only have a filename — the media:// URL carries no meetingId,
 * so they can't call rootForMeeting. Flag OFF → the single recordings dir
 * (today's behavior). Flag ON → private root, shared root (when resolved), then
 * the local staging slot where a HELD recording waits for the shared root to
 * recover.
 */
export function recordingProbeDirs(): string[] {
  if (!isTwoTierStorageEnabled()) return [getRecordingsDir()]
  const dirs = [getRecordingsDir(getPrivateRoot())]
  const shared = getSharedRoot()
  if (shared != null) dirs.push(getRecordingsDir(shared))
  dirs.push(join(getStagingDir(), 'recording')) // canonical slot for HELD recordings
  return dirs
}

/**
 * Resolve a recording FILENAME to an absolute on-disk path by probing every
 * candidate root + the held-staging slot, applying a path-traversal guard per
 * candidate (the filename arrives from an untrusted media:// URL). Returns the
 * first existing match, or null. Flag OFF → single-root lookup (today's
 * behavior, traversal-guarded exactly as the inline handler was).
 */
export function resolveRecordingFilePath(filename: string): string | null {
  if (!filename) return null
  for (const baseRaw of recordingProbeDirs()) {
    const baseDir = normalize(join(baseRaw, '/'))
    const candidate = normalize(join(baseDir, filename))
    if (!candidate.startsWith(baseDir)) continue // reject ../ traversal
    if (existsSync(candidate)) return candidate
  }
  return null
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

/** Standard local staging location for an in-progress/held file, namespaced by
 *  kind so a transcript and a summary with the same meeting-id filename don't
 *  collide. Writers stage here; resolveExistingFile checks here as a last resort
 *  so a HELD public file (shared root unresolved) is still readable locally. */
export function stagingPathFor(kind: StorageKind, filename: string): string {
  return join(getStagingDir(), kind, filename)
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
  // Last resort: a HELD public file (shared root was unresolved at write time)
  // still sits in local staging — find it so the desktop can read it meanwhile.
  // Not cached (it's transient — the queue will move it into a root).
  const staged = stagingPathFor(kind, filename)
  if (existsSync(staged)) return staged
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage → finalize (Issue 2A) + hold (Issue 3A).
//
// All in-progress writes land in a neutral LOCAL staging dir; the finalized
// artifact is MOVED into its routed root here. A recording made public then
// toggled private can therefore never pre-leak bytes to the firm Drive, and a
// public file whose shared root isn't resolved yet is HELD in staging (not
// silently mis-filed locally) for the queue to drain once resolution recovers.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceResult =
  | { kind: 'placed'; path: string }
  | { kind: 'held'; reason: 'shared-unresolved'; stagingPath: string }

/** Cross-volume-safe move (staging is local; the target root may be a Drive mount
 *  on another volume → rename throws EXDEV, fall back to copy+unlink). */
function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      copyFileSync(src, dest)
      unlinkSync(src)
    } else {
      throw err
    }
  }
}

/**
 * Move a staged file into the meeting's routed root, or HOLD it in staging when
 * the (public) destination shared root isn't resolved. On success the resolve
 * cache is primed so the first read is free.
 */
export function placeFinalizedFile(
  meeting: MeetingPrivacy & { id: string },
  kind: StorageKind,
  filename: string,
  stagingPath: string,
): PlaceResult {
  const route = rootForMeeting(meeting)
  if (route.kind === 'hold') {
    console.warn(
      `[TwoTier] place HELD meeting=${meeting.id} kind=${kind} file=${filename} reason=${route.reason}`,
    )
    return { kind: 'held', reason: route.reason, stagingPath }
  }
  const dir = dirFor(kind, route.root)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, filename)
  moveFile(stagingPath, dest)
  resolveCache.set(cacheKey(meeting.id, kind, filename), dest)
  console.log(
    `[TwoTier] place OK meeting=${meeting.id} kind=${kind} file=${filename} private=${!isPublic(meeting)}`,
  )
  return { kind: 'placed', path: dest }
}
