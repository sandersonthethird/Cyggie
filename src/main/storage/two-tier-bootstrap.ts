import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { setTwoTierSettingProvider, isTwoTierStorageEnabled } from './routing'
import { refreshSharedRoot } from './shared-root'

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier storage bootstrap (Slice 3b).
//
//  • Injects the setting-backed flag reader into routing (so routing stays
//    db-dependency-free, and the storage unit tests don't need better-sqlite3).
//  • Resolves the firm shared root at startup + on a periodic tick, which also
//    drains any HELD public files once Drive (re)mounts (refreshSharedRoot →
//    drainHoldQueue).
//
// The setting key is `twoTierStorageEnabled` ('1' = on). Default OFF.
// ─────────────────────────────────────────────────────────────────────────────

const SETTING_KEY = 'twoTierStorageEnabled'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 min

// Cache the setting read — isTwoTierStorageEnabled() is called on every storage
// route/read/write. Invalidated on a settings change via onTwoTierSettingChanged.
let flagCache: boolean | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

function readFlag(): boolean {
  if (flagCache === null) {
    try {
      flagCache = settingsRepo.getSetting(SETTING_KEY) === '1'
    } catch {
      flagCache = false // DB not ready / read failed → fail closed (legacy single-root)
    }
  }
  return flagCache
}

/** Resolve the shared root (and drain held files) when the flag is on. */
function tick(): void {
  if (!isTwoTierStorageEnabled()) return
  void refreshSharedRoot().catch((err) =>
    console.warn('[TwoTier] shared-root refresh failed (non-fatal):', err),
  )
}

/**
 * Wire the flag provider and kick off shared-root resolution. Call once during
 * main-process startup, after the DB is ready and auth/firm context is known.
 */
export function initTwoTierStorage(): void {
  setTwoTierSettingProvider(readFlag)
  tick() // resolve now (no-op when the flag is off)
  if (!refreshTimer) {
    refreshTimer = setInterval(tick, REFRESH_INTERVAL_MS)
    refreshTimer.unref?.() // don't keep the process alive for this alone
  }
}

/**
 * Called by the settings IPC when `twoTierStorageEnabled` changes: re-read the
 * cached flag and, if now enabled, immediately resolve the shared root rather
 * than waiting for the next periodic tick.
 */
export function onTwoTierSettingChanged(): void {
  flagCache = null
  tick()
}
