import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { configureSyncGlobals } from '@cyggie/db/sqlite/repositories/_sync'
import { getCurrentUserId } from '../security/current-user'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import {
  SyncAgent,
  PayloadTooLargeError,
  type SyncTransport,
  type PushBatchResponse,
} from './sync-agent'
import { SyncPullService, type PullTransport, type PullResponse } from './sync-pull.service'
import { registerSyncIpc } from '../ipc/sync.ipc'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  getAccessToken as getCyggieAccessToken,
  refresh as refreshCyggieAuth,
  signOut as signOutCyggieAuth,
} from '../auth/cyggie-auth'

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
// Auth: pulls Cyggie access tokens from cyggie-auth.ts (Desktop OAuth slice).
// On 401, calls refresh() once; if that fails with reauth_required, wipes
// tokens and lets the agent transition to 'paused_no_auth'. Renderer picks
// up the state change via SYNC_STATUS_CHANGED.
// =============================================================================

const GATEWAY_URL = process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'
const DEVICE_ID_KEY = 'syncDeviceId'

let agent: SyncAgent | null = null
let pullService: SyncPullService | null = null
let statusBroadcastTarget: WebContents | null = null

/**
 * Returns the persisted per-device id, creating one on first call. Stored
 * in the settings table (key='syncDeviceId') so it survives across app
 * restarts. Lower-case so it matches the mobile-side format.
 *
 * NOTE: cyggie-auth.ts has its own copy of this helper. They share the
 * same settings key so the IDs are always the same value across modules.
 */
function getOrCreateDeviceId(): string {
  const existing = settingsRepo.getSetting(DEVICE_ID_KEY)
  if (existing && existing.length > 0) return existing
  const fresh = randomUUID().toLowerCase()
  settingsRepo.setSetting(DEVICE_ID_KEY, fresh)
  return fresh
}

/**
 * Bridges the desktop's Cyggie token storage into the SyncAgent. Returns
 * null when the user is not signed in → agent enters 'paused_no_auth'.
 */
async function getAccessTokenForSync(): Promise<string | null> {
  return getCyggieAccessToken()
}

/**
 * Wraps fetch to /sync/push with a 401 → refresh → retry path. The agent's
 * transport throws on network / 5xx errors so the agent enters backoff.
 * 401 with `reauth_required: true` → wipe tokens + leave the rejection in
 * place so the agent records last_error and the renderer surfaces the
 * red "Re-sign-in required" pill via the next SYNC_STATUS_CHANGED.
 */
const transport: SyncTransport = {
  async push({ deviceId, batch }) {
    const tokenA = await getAccessTokenForSync()
    if (!tokenA) {
      throw new Error('NO_ACCESS_TOKEN')
    }
    const tryOnce = async (token: string): Promise<Response> =>
      fetch(`${GATEWAY_URL}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceId, batch }),
      })

    let res = await tryOnce(tokenA)

    if (res.status === 401) {
      // First refresh attempt. If the token is genuinely just expired, the
      // refresh succeeds and the retry below works. If the refresh token is
      // ALSO dead, refresh() returns null AND wipes local storage via the
      // reauth_required branch; the second tryOnce will fail with NO_ACCESS_TOKEN
      // which the agent treats as a generic error.
      const fresh = await refreshCyggieAuth()
      if (!fresh) {
        throw new Error('UNAUTHORIZED')
      }
      res = await tryOnce(fresh)
    }

    if (res.status === 401) {
      // Even after refresh — token is irrecoverable. Wipe state so the
      // renderer surfaces the re-sign-in pill.
      await signOutCyggieAuth()
      throw new Error('UNAUTHORIZED')
    }
    if (res.status >= 500) {
      throw new Error(`gateway ${res.status}`)
    }
    // T38: 413 PAYLOAD_TOO_LARGE — propagate a typed error so the agent
    // can halve its batch size and retry rather than treat it as a
    // generic 4xx (which would mark rows rejected after MAX_ATTEMPTS).
    if (res.status === 413) {
      throw new PayloadTooLargeError(`gateway 413`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => `${res.status}`)
      throw new Error(`gateway 4xx: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as PushBatchResponse
  },
}

/**
 * GET /sync/pull transport — same 401 → refresh → retry pattern as push.
 * Returns the parsed body; throws on non-2xx (the pull service maps the
 * error into backoff / sign-out states).
 */
const pullTransport: PullTransport = {
  async pull({ deviceId, since }) {
    const tokenA = await getAccessTokenForSync()
    if (!tokenA) {
      throw Object.assign(new Error('NO_ACCESS_TOKEN'), { status: 401 })
    }
    const url = `${GATEWAY_URL}/sync/pull?since=${encodeURIComponent(since)}`
    const tryOnce = async (token: string): Promise<Response> =>
      fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })

    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) {
        throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
      }
      res = await tryOnce(fresh)
    }
    if (res.status === 401) {
      await signOutCyggieAuth()
      throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
    }
    if (res.status >= 500) {
      throw Object.assign(new Error(`gateway ${res.status}`), { status: res.status })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => `${res.status}`)
      throw Object.assign(new Error(`gateway 4xx: ${text.slice(0, 200)}`), { status: res.status })
    }
    // deviceId is not currently used in the request body (gateway scopes by
    // JWT.sub) but we keep it in the transport signature for parity with
    // /sync/push and for future per-device pull filtering.
    void deviceId
    return (await res.json()) as PullResponse
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
  // token the agent transitions to 'paused_no_auth' until the user signs in
  // via the Cloud Sync settings panel.
  agent = new SyncAgent({
    db: getDatabase(),
    getUserId: () => getCurrentUserId() ?? null,
    getDeviceId: () => getOrCreateDeviceId(),
    getAccessToken: getAccessTokenForSync,
    transport,
    onStateChange: (snapshot) => {
      // Push every transition to the renderer so the Cloud Sync panel
      // doesn't have to poll. webContents may be destroyed during quit; the
      // null/destroyed check keeps us safe.
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed()) return
      wc.send(IPC_CHANNELS.SYNC_STATUS_CHANGED, snapshot)
    },
  })

  // 3. Wire IPC handlers (status / force-flush / retry-dead-letters).
  registerSyncIpc(agent)

  // 4. Kick off the periodic tick.
  agent.start()

  // 5. Phase 1.5c — construct + start the pull-side service. Shares the
  // SyncAgent reference so its pre-tick mutex check can read push state.
  pullService = new SyncPullService({
    db: getDatabase(),
    getDeviceId: () => getOrCreateDeviceId(),
    getUserId: () => getCurrentUserId() ?? null,
    getAccessToken: getAccessTokenForSync,
    syncAgent: agent,
    transport: pullTransport,
    onMeetingsApplied: (ids) => {
      // Surgical TanStack invalidation in the renderer (Issue 5A).
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.MEETINGS_REMOTE_APPLIED, { ids })
    },
    // T14 — per-table IPC fanout for the other owned tables. Each renderer
    // subscriber decides which invalidation set fires when each event arrives.
    onNotesApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.NOTES_REMOTE_APPLIED, { ids })
    },
    onOrgCompaniesApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.ORG_COMPANIES_REMOTE_APPLIED, { ids })
    },
    onOrgCompanyAliasesApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.ORG_COMPANY_ALIASES_REMOTE_APPLIED, { ids })
    },
    onContactsApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.CONTACTS_REMOTE_APPLIED, { ids })
    },
    onContactEmailsApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.CONTACT_EMAILS_REMOTE_APPLIED, { ids })
    },
    onStateChange: (snapshot) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed()) return
      wc.send(IPC_CHANNELS.SYNC_PULL_STATUS_CHANGED, snapshot)
    },
  })
  pullService.start()
  console.log('[sync] bootstrap complete; agent + pull service started')
}

/**
 * Called by cyggie-auth.handleAuthCallback after a successful sign-in. The
 * agent will likely have outbox rows queued from a paused_no_auth period;
 * triggering a flush immediately drains them rather than waiting up to 5s
 * for the next tick.
 */
export function triggerSyncFlush(): void {
  agent?.triggerFlush()
}

/**
 * Phase 1.5c — trigger an immediate pull. Called by app focus / sign-in
 * transitions so the user doesn't wait up to 60s for the periodic tick.
 * No-op when the service isn't running.
 */
export function triggerSyncPull(): void {
  pullService?.triggerPull()
}

/**
 * Bind the renderer webContents that should receive SYNC_STATUS_CHANGED
 * pushes. Call from the main window's ready handler.
 */
export function setSyncStatusBroadcastTarget(wc: WebContents | null): void {
  statusBroadcastTarget = wc
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
