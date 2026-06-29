import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'

let storagePath: string = ''

export function getDefaultStoragePath(): string {
  return join(app.getPath('documents'), 'MeetingIntelligence')
}

export function getStoragePath(): string {
  return storagePath || getDefaultStoragePath()
}

export function setStoragePath(path: string): void {
  storagePath = path
  ensureStorageDirs(path)
}

// ── Two-tier storage roots (Slice 1) ─────────────────────────────────────────
//
// Files route by meetings.is_private:
//   public  (default) → SHARED root  (admin-set Google Drive; resolved in Slice 2)
//   private (opt-in)  → PRIVATE root (per-user local machine)
//
// In Slice 1 these are behavior-preserving placeholders that both return the
// current single storagePath, so the root-parameterized dir getters below are a
// verified no-op until Slice 2 (shared-root resolution) and Slice 3 (routing)
// wire them up behind the feature flag.

// Per-user local root for a user's own private files (Slice 4). Loaded from the
// `privateStoragePath` setting at startup via setPrivateStoragePath; falls back
// to the single storagePath when the user hasn't chosen a separate private
// folder. Kept as a module var (like storagePath) so paths.ts stays db-free.
let privateStoragePath: string = ''

export function setPrivateStoragePath(path: string): void {
  privateStoragePath = path
}

/** Per-user local root for a user's own private files. Defaults to storagePath
 *  until the user picks a dedicated private folder in onboarding/Settings. */
export function getPrivateRoot(): string {
  return privateStoragePath || getStoragePath()
}

// The shared root is resolved asynchronously by storage/shared-root.ts (fetch
// firm config → resolve rel_path to this machine's Drive mount) and cached here
// so the low-level getter stays synchronous and dependency-light. `null` means
// "not resolved" (unset / Drive unmounted / folder missing) — callers must NOT
// silently fall back to local for public files (Issue 3A); the routing layer
// holds finalize and surfaces a banner instead.
let resolvedSharedRoot: string | null = null

export function setResolvedSharedRoot(path: string | null): void {
  resolvedSharedRoot = path
}

/** Firm-wide shared root for public files, or null when unresolved. */
export function getSharedRoot(): string | null {
  return resolvedSharedRoot
}

/** Always-local, non-synced staging area for in-progress writes (Issue 2A).
 *  Recordings/transcripts stream here, then move to the chosen root at finalize,
 *  so a public-then-private toggle can never pre-leak bytes to a synced folder. */
export function getStagingDir(): string {
  const dir = join(app.getPath('temp'), 'cyggie-staging')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function initializeStorage(): void {
  const path = getDefaultStoragePath()
  ensureStorageDirs(path)
  storagePath = path
}

function ensureStorageDirs(basePath: string): void {
  const dirs = [
    basePath,
    join(basePath, 'transcripts'),
    join(basePath, 'summaries'),
    join(basePath, 'recordings'),
    join(basePath, 'memos')
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

// Dir getters take an optional `root` (Issue 1A — behavior-preserving). With no
// argument they resolve against the current single storagePath, exactly as
// before. Slice 3 passes a meeting-derived root (rootForMeeting) when the
// two-tier flag is on; until then every call site is an unchanged no-op.

export function getTranscriptsDir(root: string = getStoragePath()): string {
  return join(root, 'transcripts')
}

export function getSummariesDir(root: string = getStoragePath()): string {
  return join(root, 'summaries')
}

export function getRecordingsDir(root: string = getStoragePath()): string {
  return join(root, 'recordings')
}

export function getDatabasePath(): string {
  // DB intentionally stays at the single local storagePath, never a per-meeting
  // root — it's local+Neon only (cloud-syncing a live WAL risks corruption).
  return join(getStoragePath(), 'echovault.db')
}

export function getMemosDir(root: string = getStoragePath()): string {
  return join(root, 'memos')
}
