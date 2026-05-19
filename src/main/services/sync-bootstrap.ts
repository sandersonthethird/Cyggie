import { randomUUID } from 'node:crypto'
import Constants from 'node:process'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { configureSyncGlobals } from '@cyggie/db/sqlite/repositories/_sync'
import { getCurrentUserId } from '../security/current-user'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { SyncAgent, type SyncTransport, type PushBatchResponse } from './sync-agent'
import { registerSyncIpc } from '../ipc/sync.ipc'

// =============================================================================
// sync-bootstrap.ts — wires the SyncAgent into the desktop main process.
//
// Called once during app.whenReady, AFTER:
//   • Database is open and migrated (migration 096 + 097 applied)
//   • Default user identity is established (getCurrentUserId returns non-null)
//
// Order matters: configureSyncGlobals MUST run before the first call to any
// barrel-wrapped repo function (otherwise withSync throws on missing globals).
//
// Auth gap (Phase 1.5a): the desktop has no OAuth flow yet. The agent is
// constructed with a getAccessToken accessor that returns null until a token
// becomes available; the agent pauses in 'paused_no_auth' state and outbox
// rows accumulate locally. When desktop OAuth lands (follow-up), wire the
// access-token store into `getAccessTokenForSync` and the agent resumes.
// =============================================================================

const GATEWAY_URL = process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'
const DEVICE_ID_KEY = 'syncDeviceId'

let agent: SyncAgent | null = null

/**
 * Returns the persisted per-device id, creating one on first call. Stored
 * in the settings table (key='syncDeviceId') so it survives across app
 * restarts. Lower-case so it matches the mobile-side format.
 */
function getOrCreateDeviceId(): string {
  const existing = settingsRepo.getSetting(DEVICE_ID_KEY)
  if (existing && existing.length > 0) return existing
  const fresh = randomUUID().toLowerCase()
  settingsRepo.setSetting(DEVICE_ID_KEY, fresh)
  return fresh
}

/**
 * Placeholder for the desktop access-token accessor. Returns null while
 * desktop OAuth is unbuilt. Replace with the real implementation when
 * desktop OAuth lands.
 */
async function getAccessTokenForSync(): Promise<string | null> {
  // TODO(desktop-oauth): pull from secure storage / refresh as needed.
  return null
}

/**
 * Real HTTP transport for POST /sync/push. Uses Node's global fetch (≥18).
 * Throws on 5xx / network errors so SyncAgent enters backoff; 4xx responses
 * with a parsed body fall through to the agent's normal rejected/conflicts
 * handling.
 */
const transport: SyncTransport = {
  async push({ deviceId, batch }) {
    const token = await getAccessTokenForSync()
    if (!token) {
      throw new Error('NO_ACCESS_TOKEN')
    }
    const res = await fetch(`${GATEWAY_URL}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ deviceId, batch }),
    })
    if (res.status >= 500) {
      throw new Error(`gateway ${res.status}`)
    }
    if (res.status === 401) {
      // Treat 401 like 5xx for now — the agent's backoff will retry once
      // an access token becomes available. The proper path (sign user out)
      // ships with desktop OAuth.
      throw new Error('UNAUTHORIZED')
    }
    if (!res.ok) {
      // 4xx but not 401 — surface the body as an error so the agent records
      // last_error. Could be a malformed batch from an old build.
      const text = await res.text().catch(() => `${res.status}`)
      throw new Error(`gateway 4xx: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as PushBatchResponse
  },
}

/**
 * Initialize sync. Idempotent — calling twice is a no-op.
 */
export function bootstrapSync(): void {
  if (agent) return

  // 1. Configure globals so the barrel-wrapped writes can resolve user_id /
  // device_id / db on each call.
  configureSyncGlobals({
    getDb: () => getDatabase(),
    getUserId: () => getCurrentUserId() ?? null,
    getDeviceId: () => getOrCreateDeviceId(),
  })

  // 2. Construct the SyncAgent. It starts in IDLE; the first tick (or any
  // wrapped write's triggerFlush) will attempt a drain. Without an access
  // token the agent transitions to 'paused_no_auth' — that's expected
  // until desktop OAuth lands.
  agent = new SyncAgent({
    db: getDatabase(),
    getUserId: () => getCurrentUserId() ?? null,
    getDeviceId: () => getOrCreateDeviceId(),
    getAccessToken: getAccessTokenForSync,
    transport,
  })

  // 3. Wire IPC handlers (status / force-flush / retry-dead-letters).
  registerSyncIpc(agent)

  // 4. Kick off the periodic tick.
  agent.start()
  console.log('[sync] bootstrap complete; agent started (paused until access token available)')
}

/**
 * Stop the SyncAgent — called on app quit so the periodic timer doesn't
 * keep Node alive.
 */
export function shutdownSync(): void {
  if (agent) {
    agent.stop()
    agent = null
  }
}
