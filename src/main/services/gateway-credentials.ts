import { getAccessToken } from '../auth/cyggie-auth'
import { getCredential } from '../security/credentials'

// T24 — desktop → gateway credential push.
//
// The user pastes their Anthropic API key into desktop Settings. Until
// T24, that key lived only in local SQLite — the gateway had no way to
// reach it, so the M5-thin chat routes had to fall back to a separate
// gateway-owned key in Fly env. That meant TWO places to paste (desktop
// Settings + flyctl secrets), and external users would unknowingly bill
// against the gateway-owner's account.
//
// This module is the desktop side of the fix: when the user saves a
// claudeApiKey on desktop, we PUT it to /user-credentials/anthropic on
// the gateway. The gateway upserts into the user_credentials table and
// reads it from there on every chat request (resolveAnthropicKey in
// api-gateway/src/routes/chat.ts).
//
// Failure mode: pushAnthropicKey() is best-effort. If the gateway is
// down or the JWT has expired, we log + swallow. The desktop's local
// key still works for desktop-side LLM calls; only mobile chat is
// affected, and the next successful desktop launch backfills.

const GATEWAY_URL =
  process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

/**
 * Push the user's Anthropic key to the gateway. Best-effort — does not
 * throw, only logs. Caller doesn't need to await.
 */
export async function pushAnthropicKey(value: string): Promise<void> {
  if (!value || value.trim().length === 0) return

  const token = await getAccessToken()
  if (!token) {
    console.log(
      '[gateway-credentials] no access token; skipping anthropic key push',
    )
    return
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/user-credentials/anthropic`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ value }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(
        `[gateway-credentials] push failed status=${res.status} body=${body.slice(0, 200)}`,
      )
      return
    }
    console.log('[gateway-credentials] anthropic key pushed to gateway')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-credentials] push failed err=${msg}`)
  }
}

/**
 * On desktop launch, if a local claudeApiKey exists, push it to the
 * gateway. Idempotent (gateway upserts by user_id+provider), so safe to
 * run on every boot — also self-heals drift if the gateway was wiped or
 * the desktop key was rotated while offline.
 *
 * Runs in the background — does not block app startup.
 */
export function backfillAnthropicKeyOnLaunch(): void {
  // Defer until after the main thread settles so we don't compete with
  // the SyncAgent's first tick and other startup work.
  setTimeout(() => {
    const local = getCredential('claudeApiKey')
    if (!local) return
    void pushAnthropicKey(local)
  }, 2000)
}
