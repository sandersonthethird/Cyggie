import { shell, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { parseCallbackUrl, type SignInResult } from '@cyggie/shared/auth-callback'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  storeCyggieTokens,
  storeCyggieRefreshedTokens,
  getCyggieAccessTokenSync,
  getCyggieRefreshToken,
  getCyggieUserId,
  getCyggieUserEmail,
  clearCyggieTokens,
} from './cyggie-auth-storage'
import { getCurrentFirmId } from '../security/current-firm'

// =============================================================================
// cyggie-auth.ts — orchestrator for the desktop's gateway-OAuth flow.
//
// Flow:
//   1. startSignIn()        → POST /auth/google/start { redirect_target: 'desktop' }
//                              → shell.openExternal(authUrl) to system browser
//   2. user consents at Google
//   3. gateway 302s to cyggie-desktop://auth-callback?session=&refresh=&user_id=…
//   4. macOS open-url / Win+Linux second-instance → handleAuthCallback(url)
//   5. parseCallbackUrl → storeCyggieTokens → broadcast → trigger sync flush
//
// Refresh:
//   getAccessToken() reads cache; if null, attempts refresh() via the gateway's
//   /auth/refresh route. refresh() is single-flight so concurrent /sync/push
//   401s coalesce onto the same in-flight Promise (otherwise the second
//   rotation would invalidate the first).
//
// Sign-out:
//   Best-effort POST /auth/logout, then clear local storage + in-memory cache,
//   then broadcast status change. Pending outbox rows are NOT wiped — they
//   survive into the next sign-in; the sync wrapper's user_id check at
//   _sync.ts keeps cross-user contamination impossible.
// =============================================================================

const DEVICE_ID_KEY = 'syncDeviceId' // shared with sync-bootstrap.ts
const GATEWAY_URL =
  process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

// Renderer broadcast target. Updated whenever a sign-in/out/refresh changes
// the auth state.
let broadcastTarget: WebContents | null = null

export function setAuthBroadcastTarget(wc: WebContents | null): void {
  broadcastTarget = wc
}

// Device-id mirror of sync-bootstrap's helper. Importing here avoids a
// circular dep (sync-bootstrap.ts already imports from cyggie-auth.ts).
function getOrCreateDeviceId(): string {
  const existing = settingsRepo.getSetting(DEVICE_ID_KEY)
  if (existing && existing.length > 0) return existing
  const fresh = randomUUID().toLowerCase()
  settingsRepo.setSetting(DEVICE_ID_KEY, fresh)
  return fresh
}

function broadcastStatus(): void {
  const wc = broadcastTarget
  if (!wc || wc.isDestroyed()) return
  wc.send(IPC_CHANNELS.CYGGIE_AUTH_STATUS_CHANGED, getStatus())
}

export interface CyggieAuthStatus {
  signedIn: boolean
  email: string | null
  userId: string | null
  // firm_id decoded from the access token (null until onboarding completes).
  // Slice B: lets the renderer key its firm-template seed marker without a
  // network round-trip, so the /firms/me fetch only fires the first time.
  firmId: string | null
}

export function getStatus(): CyggieAuthStatus {
  const token = getCyggieAccessTokenSync()
  return {
    signedIn: token != null && token.length > 0,
    email: getCyggieUserEmail(),
    userId: getCyggieUserId(),
    firmId: getCurrentFirmId(),
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Sign-in: open the gateway's OAuth flow in the system browser.
// ───────────────────────────────────────────────────────────────────────────

export async function startSignIn(opts: { deviceLabel?: string } = {}): Promise<{
  ok: boolean
  error?: string
}> {
  try {
    const res = await fetch(`${GATEWAY_URL}/auth/google/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: getOrCreateDeviceId(),
        device_label: opts.deviceLabel ?? 'Desktop',
        redirect_target: 'desktop',
      }),
    })
    if (!res.ok) {
      return { ok: false, error: `GATEWAY_${res.status}` }
    }
    const body = (await res.json()) as { authUrl: string }
    await shell.openExternal(body.authUrl)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'NETWORK' }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Callback: invoked by main/index.ts's open-url + second-instance handlers.
// ───────────────────────────────────────────────────────────────────────────

export async function handleAuthCallback(
  url: string,
  _wc: WebContents | null = null,
): Promise<SignInResult> {
  const result = parseCallbackUrl(url)
  if (result.kind !== 'success') {
    // Errors arrive when the user cancels Google, or when a stale
    // already-consumed state shows up. Don't surface as a crash — log and
    // broadcast unchanged status so the renderer can re-arm sign-in.
    console.warn('[cyggie-auth] callback rejected:', result)
    broadcastStatus()
    return result
  }
  storeCyggieTokens({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    userId: result.userId,
    // Gateway includes the verified Google email in the deep-link query as
    // of 2026-05. Older gateway builds didn't — email is null in that case
    // and the renderer pill falls back to "Connected" until next sign-in.
    email: result.email ?? '',
  })
  broadcastStatus()

  // Now that the gateway id is known, heal any notes mis-stamped with it so the
  // user's own round-tripped notes aren't locked read-only. Best-effort + runs
  // once; safe to call on every sign-in.
  try {
    const { reconcileGatewayIdentity } = await import('../security/identity-reconcile')
    reconcileGatewayIdentity()
  } catch {
    // Module not loaded (e.g. tests) — startup will reconcile on next launch.
  }

  // Trigger an immediate sync drain — the outbox may have rows pending from
  // the paused_no_auth period. Late-binding via require avoids the circular
  // import (sync-bootstrap imports cyggie-auth).
  try {
    const { triggerSyncFlush } = await import('../services/sync-bootstrap')
    triggerSyncFlush()
  } catch {
    // sync-bootstrap not loaded yet (e.g. during tests). Safe to ignore;
    // the next 5s tick will drain.
  }
  // Same for the attachment byte-outbox: drain any images queued while signed out.
  try {
    const { triggerAttachmentUploadFlush } = await import(
      '../services/attachment-upload-flusher.service'
    )
    triggerAttachmentUploadFlush()
  } catch {
    // flusher not started yet — its next 5s tick will drain.
  }
  return result
}

// ───────────────────────────────────────────────────────────────────────────
// Refresh: single-flight rotation against /auth/refresh.
// ───────────────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<string | null> | null = null

export async function refresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const refreshToken = getCyggieRefreshToken()
      if (!refreshToken) return null
      const res = await fetch(`${GATEWAY_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: refreshToken,
          device_id: getOrCreateDeviceId(),
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          reauth_required?: boolean
        }
        if (body.reauth_required) {
          await signOut()
        }
        return null
      }
      const body = (await res.json()) as {
        access_token: string
        refresh_token: string
      }
      storeCyggieRefreshedTokens({
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
      })
      return body.access_token
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * Returns the current access token, fetching a fresh one via refresh() if
 * the cache is empty. Returns null when the user is not signed in (caller's
 * cue to surface the sign-in UI or pause the SyncAgent).
 */
export async function getAccessToken(): Promise<string | null> {
  const cached = getCyggieAccessTokenSync()
  if (cached) return cached
  return refresh()
}

// ───────────────────────────────────────────────────────────────────────────
// Sign-out: best-effort gateway notification + local wipe.
// ───────────────────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  const token = getCyggieAccessTokenSync()
  if (token) {
    try {
      await fetch(`${GATEWAY_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      // Best-effort. Don't block sign-out on network.
    }
  }
  clearCyggieTokens()
  broadcastStatus()
}

// Test seam: reset the in-flight refresh tracker so tests can simulate a
// fresh process. NEVER call from production code.
export function _resetRefreshInFlightForTesting(): void {
  refreshInFlight = null
}
