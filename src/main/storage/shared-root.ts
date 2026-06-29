import { homedir } from 'os'
import { join } from 'path'
import { readdirSync, statSync } from 'fs'
import { fetchFirmStorageConfig, type FirmStorageSpec } from '../services/gateway-firm'
import { setResolvedSharedRoot } from './paths'

// ─────────────────────────────────────────────────────────────────────────────
// Shared-root resolver (two-tier storage, Slice 2/3).
//
// The firm's SHARED files location is stored on Neon as a mount-relative Drive
// spec (e.g. "Shared drives/Cyggie/Meeting Notes"). A shared Google Drive folder
// resolves to a DIFFERENT absolute path on every user's machine because the
// CloudStorage prefix embeds their account:
//
//   ~/Library/CloudStorage/GoogleDrive-alice@firm.com/Shared drives/Cyggie/…
//   ~/Library/CloudStorage/GoogleDrive-bob@firm.com/Shared drives/Cyggie/…
//
// So each client enumerates its own GoogleDrive-* mounts and finds the one whose
// tree actually contains rel_path. Resolution result feeds paths.ts via
// setResolvedSharedRoot so the synchronous getSharedRoot() stays dependency-light.
//
//   refreshSharedRoot()  ── fetch config ─▶ resolveSpecToMount ─▶ cache + paths.ts
//   getSharedRootState() ── what routing/onboarding read to decide hold vs route
// ─────────────────────────────────────────────────────────────────────────────

export type SharedRootResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'no-spec' | 'no-drive-mount' | 'folder-not-found' }

interface ResolveDeps {
  /** Override the home dir (tests). Defaults to os.homedir(). */
  home?: string
  /** List entry names of a dir; returns [] on error. Injectable for tests. */
  listDir?: (dir: string) => string[]
  /** True if path is an existing directory. Injectable for tests. */
  isDir?: (p: string) => boolean
}

/**
 * Pure resolver: map a firm storage spec to this machine's absolute mount path,
 * or explain why it can't. No network, no module state — unit-testable with
 * fixtured deps. A null spec means the firm hasn't set a shared folder yet.
 */
export function resolveSpecToMount(
  spec: FirmStorageSpec | null,
  deps: ResolveDeps = {},
): SharedRootResolution {
  if (!spec) return { ok: false, reason: 'no-spec' }

  const home = deps.home ?? homedir()
  const listDir =
    deps.listDir ??
    ((d: string): string[] => {
      try {
        return readdirSync(d)
      } catch {
        return []
      }
    })
  const isDir =
    deps.isDir ??
    ((p: string): boolean => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })

  const cloudStorage = join(home, 'Library', 'CloudStorage')
  const mounts = listDir(cloudStorage).filter((n) => n.startsWith('GoogleDrive-'))
  if (mounts.length === 0) return { ok: false, reason: 'no-drive-mount' }

  // Multiple Google accounts may be mounted; pick the first whose tree actually
  // contains rel_path (deterministic by readdir order).
  for (const m of mounts) {
    const candidate = join(cloudStorage, m, spec.relPath)
    if (isDir(candidate)) return { ok: true, path: candidate }
  }
  return { ok: false, reason: 'folder-not-found' }
}

export type SharedRootState =
  | { status: 'unset' } // firm hasn't designated a shared folder yet
  | { status: 'resolved'; path: string }
  | { status: 'unresolved'; reason: 'no-drive-mount' | 'folder-not-found' | 'fetch-failed' }

let cachedState: SharedRootState = { status: 'unset' }

/** What routing/onboarding read to decide route-to-shared vs hold-finalize (3A). */
export function getSharedRootState(): SharedRootState {
  return cachedState
}

/** Test-only reset of the module cache. */
export function __resetSharedRootCacheForTests(): void {
  cachedState = { status: 'unset' }
  setResolvedSharedRoot(null)
}

/**
 * Fetch the firm config and (re)resolve the shared root for this machine.
 * Offline-tolerant: if the fetch fails but we previously resolved a path, keep
 * it (stale-ok) rather than dropping public files to a hold state on a blip.
 */
export async function refreshSharedRoot(): Promise<SharedRootState> {
  const fetched = await fetchFirmStorageConfig()

  if (!fetched.ok) {
    if (cachedState.status === 'resolved') return cachedState // stale-ok
    cachedState = { status: 'unresolved', reason: 'fetch-failed' }
    setResolvedSharedRoot(null)
    return cachedState
  }

  const res = resolveSpecToMount(fetched.config)
  if (res.ok) {
    cachedState = { status: 'resolved', path: res.path }
    setResolvedSharedRoot(res.path)
  } else if (res.reason === 'no-spec') {
    cachedState = { status: 'unset' }
    setResolvedSharedRoot(null)
  } else {
    cachedState = { status: 'unresolved', reason: res.reason }
    setResolvedSharedRoot(null)
  }
  return cachedState
}
