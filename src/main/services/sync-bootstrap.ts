import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { configureSyncGlobals } from '@cyggie/db/sqlite/repositories/_sync'
import { getCurrentUserId } from '../security/current-user'
import { upsertFirmMembers } from '@cyggie/db/sqlite/repositories/user.repo'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import {
  SyncAgent,
  PayloadTooLargeError,
  type SyncTransport,
  type PushBatchResponse,
} from './sync-agent'
import { SyncPullService, type PullTransport, type PullResponse } from './sync-pull.service'
import { resetPullWatermarkForRepullOnce } from './sync-repull-once.service'
import { repushBlankHealedNotes } from './note-blank-heal.service'
import { registerSyncIpc } from '../ipc/sync.ipc'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  getAccessToken as getCyggieAccessToken,
  refresh as refreshCyggieAuth,
  signOut as signOutCyggieAuth,
} from '../auth/cyggie-auth'
import type { TranscriptSegment } from '../../shared/types/recording'

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
    // T40 — opt into lazy transcripts. The gateway suppresses transcript_segments
    // from the pull firehose; we fetch them on-demand via fetchTranscript() when
    // a meeting is opened. Old desktop builds omit this param and keep receiving
    // full transcripts, so the rollout has no degradation window.
    const url = `${GATEWAY_URL}/sync/pull?since=${encodeURIComponent(since)}&lazyTranscripts=1`
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
 * Firm directory sync — mirror GET /firms/me/members into the local users table
 * so multiplayer attribution ("created by / last edited by / shared by")
 * resolves offline. Fire-and-forget + best-effort: any failure is logged and
 * swallowed (attribution degrades to timestamps, never blocks sync). Same
 * 401 → refresh → retry pattern as the pull transport.
 */
async function syncFirmDirectory(): Promise<void> {
  try {
    const tokenA = await getAccessTokenForSync()
    if (!tokenA) return
    const url = `${GATEWAY_URL}/firms/me/members`
    const tryOnce = (token: string): Promise<Response> =>
      fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) return
      res = await tryOnce(fresh)
    }
    if (!res.ok) return
    const body = (await res.json()) as {
      members: Array<{
        id: string
        email: string | null
        display_name: string | null
        avatar_url: string | null
        role: string
      }>
    }
    const n = upsertFirmMembers(
      body.members.map((m) => ({
        id: m.id,
        email: m.email,
        displayName: m.display_name,
        avatarUrl: m.avatar_url,
        role: m.role,
      })),
    )
    console.log(`[sync.directory] upserted ${n} firm member(s)`)
  } catch (err) {
    console.warn('[sync.directory] firm member sync failed', err)
  }
}

/**
 * Admin hard-purge (Phase 3) — POST the gateway purge endpoint (it hard-deletes
 * the Neon row + writes a tombstone), then trigger a pull so the tombstone comes
 * back and this device hard-deletes its local copy (uniform path). The gateway
 * enforces requireAdmin; a non-admin caller gets a 403 surfaced as a throw.
 */
export async function purgeEntityRemote(
  entityType: 'company' | 'task',
  id: string,
): Promise<boolean> {
  const seg = entityType === 'company' ? 'companies' : 'tasks'
  const url = `${GATEWAY_URL}/admin/${seg}/${encodeURIComponent(id)}/purge`
  const tokenA = await getAccessTokenForSync()
  if (!tokenA) throw new Error('NO_ACCESS_TOKEN')
  const tryOnce = (token: string): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  let res = await tryOnce(tokenA)
  if (res.status === 401) {
    const fresh = await refreshCyggieAuth()
    if (fresh) res = await tryOnce(fresh)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`purge failed (${res.status}) ${detail}`.trim())
  }
  const body = (await res.json()) as { purged: boolean }
  pullService?.triggerPull() // pull the tombstone → local hard-delete
  return body.purged
}

/**
 * T40 — on-demand transcript fetch. The /sync/pull firehose no longer ships
 * transcript_segments (we send lazyTranscripts=1), so when the user opens a
 * meeting whose transcript isn't cached locally, we pull it from the gateway
 * here. Same 401 → refresh → retry pattern as the pull transport.
 *
 * Returns the segments in the desktop's stored shape (drops the gateway's
 * resolved `speakerLabel` — the renderer resolves names from the local
 * speakerMap, which still arrives via pull — and stamps `isFinal: true` since
 * a fetched transcript is always finalized). Throws on non-2xx so the caller
 * can surface a retry; the meeting itself still opens.
 */
export async function fetchTranscript(meetingId: string): Promise<TranscriptSegment[]> {
  const tokenA = await getAccessTokenForSync()
  if (!tokenA) throw Object.assign(new Error('NO_ACCESS_TOKEN'), { status: 401 })
  const url = `${GATEWAY_URL}/meetings/${encodeURIComponent(meetingId)}/transcript`
  const tryOnce = (token: string): Promise<Response> =>
    fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })

  let res = await tryOnce(tokenA)
  if (res.status === 401) {
    const fresh = await refreshCyggieAuth()
    if (!fresh) throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
    res = await tryOnce(fresh)
  }
  if (res.status === 401) {
    await signOutCyggieAuth()
    throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => `${res.status}`)
    throw Object.assign(new Error(`gateway ${res.status}: ${text.slice(0, 200)}`), {
      status: res.status,
    })
  }
  const body = (await res.json()) as {
    transcriptSegments: Array<{
      speaker: number
      text: string
      startTime: number
      endTime: number
    }>
  }
  return (body.transcriptSegments ?? []).map((s) => ({
    speaker: s.speaker,
    text: s.text,
    startTime: s.startTime,
    endTime: s.endTime,
    isFinal: true,
  }))
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

  // Dev/test escape hatch: CYGGIE_LOCAL_ONLY=1 keeps everything on the local drive.
  // The agent + IPC are constructed (so the Cloud Sync panel still renders) but we do
  // NOT start push ticks, the pull service, the one-time re-pulls, or the firm-directory
  // pull. Combined with withSync's skip-emit, no data flows to or from Neon this session.
  if (process.env['CYGGIE_LOCAL_ONLY'] === '1') {
    console.warn(
      '[sync] CYGGIE_LOCAL_ONLY active — push & pull disabled; all writes stay on the local drive.',
    )
    return
  }

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
    // Console-backed logger so pull progress + per-chunk apply failures are
    // visible. Previously omitted, which silently swallowed every
    // `sync.pull.tx_rollback` — masking apply errors that stall whole tables.
    log: {
      info: (payload, msg) => console.log(`[sync.pull] ${msg}`, JSON.stringify(payload)),
      warn: (payload, msg) => console.warn(`[sync.pull] ${msg}`, JSON.stringify(payload)),
      error: (payload, msg) => console.error(`[sync.pull] ${msg}`, JSON.stringify(payload)),
    },
    // Per-table IPC fanout. Each callback below broadcasts a *_REMOTE_APPLIED
    // event to the renderer with the affected row ids so screens can refresh
    // without waiting for ipcCache TTL. Renderer subscribers attach via the
    // `useRemoteApply(channel, cb)` hook (renderer/api/useRemoteApply.ts),
    // which also runs the table → cache-key invalidation (INVALIDATIONS_BY_TABLE
    // in renderer/api/ipcCache.ts) so the next refetch sees fresh state.
    //
    // Channels emitted here:
    //   • MEETINGS_REMOTE_APPLIED                 (Issue 5A / Bug A)
    //   • NOTES_REMOTE_APPLIED                    (T14)
    //   • ORG_COMPANIES_REMOTE_APPLIED            (T14)
    //   • ORG_COMPANY_ALIASES_REMOTE_APPLIED      (T14)
    //   • CONTACTS_REMOTE_APPLIED                 (T14)
    //   • CONTACT_EMAILS_REMOTE_APPLIED           (T14)
    //   • CHAT_SESSIONS_REMOTE_APPLIED            (2026-05-24, Bug B)
    //   • CHAT_SESSION_MESSAGES_REMOTE_APPLIED    (2026-05-24, Bug B)
    onMeetingsApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.MEETINGS_REMOTE_APPLIED, { ids })
    },
    onNotesApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.NOTES_REMOTE_APPLIED, { ids })
    },
    // Notes-heal: re-push local content for corrupted blank notes the pull
    // reconcile refused, so Neon's blank (and mobile) gets the real note.
    onBlankNotesRepush: (ids) => {
      repushBlankHealedNotes(ids)
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
    onChatSessionsApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.CHAT_SESSIONS_REMOTE_APPLIED, { ids })
    },
    onChatSessionMessagesApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.CHAT_SESSION_MESSAGES_REMOTE_APPLIED, { ids })
    },
    onTasksApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.TASKS_REMOTE_APPLIED, { ids })
    },
    // Phase 3 — a hard-purge tombstone removes a company and/or task locally;
    // refresh both lists (+ recycle bin) by reusing the existing channels.
    onTombstonesApplied: (ids) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed() || ids.length === 0) return
      wc.send(IPC_CHANNELS.ORG_COMPANIES_REMOTE_APPLIED, { ids })
      wc.send(IPC_CHANNELS.TASKS_REMOTE_APPLIED, { ids })
    },
    onStateChange: (snapshot) => {
      const wc = statusBroadcastTarget
      if (!wc || wc.isDestroyed()) return
      wc.send(IPC_CHANNELS.SYNC_PULL_STATUS_CHANGED, snapshot)
    },
  })
  // 6. One-time, race-proof full re-pulls (each guarded by its own flag). Runs
  // BEFORE pullService.start() so no in-flight pull can clobber the reset (PR 2b's
  // deferred reset lost exactly that race). A failed reset must never block sync.
  //   - meetingRepullV2Done: heal meetings/contacts after migration 123.
  //   - notesBlankRepullV1Done: surface corrupted blank notes so the pull
  //     reconcile refuses + re-pushes them (reconcileBlankNote / note-blank-heal).
  try {
    const db = getDatabase()
    resetPullWatermarkForRepullOnce(db, 'meetingRepullV2Done')
    resetPullWatermarkForRepullOnce(db, 'notesBlankRepullV1Done')
  } catch (err) {
    console.error('[sync-repull] watermark reset failed (non-fatal):', err)
  }

  pullService.start()

  // Populate the local firm directory so teammate attribution resolves. Runs
  // before teammate companies are rendered; refreshed on focus (triggerSyncPull).
  void syncFirmDirectory()
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
  // Refresh the firm directory on focus so newly-added teammates' names resolve.
  void syncFirmDirectory()
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
