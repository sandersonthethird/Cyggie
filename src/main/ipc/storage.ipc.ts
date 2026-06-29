import { ipcMain } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getSharedRootState, refreshSharedRoot } from '../storage/shared-root'
import { getHoldQueueDepth, setHoldQueueChangeListener } from '../storage/hold-queue'
import { isTwoTierStorageEnabled } from '../storage/routing'
import { getPrivateRoot, setPrivateStoragePath } from '../storage/paths'
import { getCurrentFirmRole, type FirmRole } from '../security/current-firm'
import { fetchFirmName, putFirmStorageConfig } from '../services/gateway-firm'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { broadcast } from './_broadcast'

// =============================================================================
// storage.ipc.ts — two-tier shared-folder status for the renderer banner (3A).
//
//   STORAGE_SHARED_STATUS          → pull a snapshot
//   STORAGE_SHARED_STATUS_CHANGED  → push when the held-finalize queue changes
//
// `paused` is the single boolean the banner renders on: it's true only when the
// shared root is unresolved AND at least one public file is waiting in the
// held-finalize queue (so we don't nag when nothing is actually blocked). The
// message is a deliberately STRAIGHT status string — no brand-voice flavor —
// per the voice "straight path" rule for operational status.
// =============================================================================

export interface SharedStorageStatus {
  paused: boolean
  queueDepth: number
  message: string | null
}

const PAUSED_MESSAGE = 'Shared files folder unavailable — new shared files are paused.'

export function computeSharedStorageStatus(): SharedStorageStatus {
  if (!isTwoTierStorageEnabled()) return { paused: false, queueDepth: 0, message: null }
  const queueDepth = getHoldQueueDepth()
  const unresolved = getSharedRootState().status === 'unresolved'
  const paused = unresolved && queueDepth > 0
  return { paused, queueDepth, message: paused ? PAUSED_MESSAGE : null }
}

export interface StorageOnboardingInfo {
  role: FirmRole
  /** Firm name for the member "inherited shared folder" line; null = unknown. */
  firmName: string | null
  /** Current per-user private root (the default if not yet chosen). */
  privatePath: string
}

/** Read-only writability probe (additive — does NOT mutate any storage path). */
function isDirWritable(dir: string): boolean {
  try {
    const probe = join(dir, `.cyggie-write-test-${process.pid}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function registerStorageIpc(): void {
  ipcMain.handle(IPC_CHANNELS.STORAGE_SHARED_STATUS, () => computeSharedStorageStatus())

  // Push a fresh status to every window whenever the held-queue depth changes
  // (a public file gets held, or the queue drains after the root recovers) so
  // the banner appears/clears promptly without the renderer polling.
  setHoldQueueChangeListener(() => {
    broadcast(IPC_CHANNELS.STORAGE_SHARED_STATUS_CHANGED, computeSharedStorageStatus())
  })

  // ── Onboarding Storage step (Slice 4) ──────────────────────────────────────

  // Role (from the gateway JWT) + firm name (members, for the inherited line) +
  // the current private root. Admins pick two folders; members pick one.
  ipcMain.handle(IPC_CHANNELS.STORAGE_ONBOARDING_INFO, async (): Promise<StorageOnboardingInfo> => {
    const role = getCurrentFirmRole()
    const firmName = role === 'member' ? await fetchFirmName() : null
    return { role, firmName, privatePath: getPrivateRoot() }
  })

  // Read-only writability check for a candidate folder (additive IPC — never
  // mutates APP_CHANGE_STORAGE_DIR). The renderer uses it for a non-blocking
  // warning; a local private folder is always the safe default.
  ipcMain.handle(IPC_CHANNELS.APP_DIR_WRITABLE, (_e, absPath: string) => {
    return typeof absPath === 'string' && absPath.length > 0 && isDirWritable(absPath)
  })

  // Persist the per-user private root (local). Updates the live getPrivateRoot()
  // and the synced-never `privateStoragePath` setting.
  ipcMain.handle(IPC_CHANNELS.STORAGE_SET_PRIVATE_DIR, (_e, absPath: string) => {
    if (typeof absPath !== 'string' || absPath.length === 0) return { ok: false }
    setPrivateStoragePath(absPath)
    settingsRepo.setSetting('privateStoragePath', absPath)
    return { ok: true }
  })

  // Admin only in the UI: set the firm-wide shared (Drive) folder as a
  // mount-relative spec, then resolve it immediately. putFirmStorageConfig
  // surfaces failure (explicit user action, not best-effort).
  ipcMain.handle(IPC_CHANNELS.STORAGE_SET_SHARED_DIR, async (_e, relPath: string) => {
    if (typeof relPath !== 'string' || relPath.length === 0) return { ok: false }
    const res = await putFirmStorageConfig(relPath)
    if (res.ok) void refreshSharedRoot().catch(() => { /* resolved on next tick */ })
    return { ok: res.ok }
  })
}
