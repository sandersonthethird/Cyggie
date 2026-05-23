import { getAccessToken, refresh as refreshCyggieAuth } from '../auth/cyggie-auth'
import { getCredential } from '../security/credentials'

// T24 / T32 — desktop → gateway credential push.
//
// The user pastes provider keys (Anthropic, Deepgram, …) into desktop
// Settings. Until T24/T32, those keys lived only in local SQLite — the
// gateway had no way to reach them, so its routes fell back to a separate
// gateway-owned key in Fly env. That meant TWO places to paste (desktop
// Settings + flyctl secrets), and external users would unknowingly bill
// against the gateway-owner's account.
//
// This module is the desktop side of the fix: when the user saves a
// provider key on desktop, we PUT it to /user-credentials/:provider on
// the gateway. The gateway upserts into the user_credentials table and
// reads it from there on every provider call (resolveAnthropicKey /
// resolveDeepgramKey in api-gateway/src/llm/resolve-key.ts).
//
// Failure mode: pushProviderKey() is best-effort. If the gateway is
// down or the JWT has expired, we log + swallow. The desktop's local
// key still works for desktop-side calls; only mobile/gateway flows are
// affected, and the next successful desktop launch backfills.

const GATEWAY_URL =
  process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

/** Providers that can be pushed to the gateway. Mirrors the gateway's
 * ALLOWED_PROVIDERS in routes/user-credentials.ts. */
export type PushableProvider = 'anthropic' | 'deepgram'

/**
 * Push a provider key to the gateway. Best-effort — does not throw, only
 * logs. Caller doesn't need to await.
 *
 * Implements the same 401 → refresh → retry pattern as the SyncAgent's
 * push transport so a stale cached access token doesn't drop the
 * backfill on the floor (which would leave gateway routes using the env
 * fallback indefinitely).
 */
export async function pushProviderKey(
  provider: PushableProvider,
  value: string,
): Promise<void> {
  if (!value || value.trim().length === 0) return

  const tokenA = await getAccessToken()
  if (!tokenA) {
    console.log(
      `[gateway-credentials] no access token; skipping ${provider} key push`,
    )
    return
  }

  const tryOnce = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}/user-credentials/${provider}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ value }),
    })

  try {
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      // Cached token was stale. Force a refresh and retry once.
      const fresh = await refreshCyggieAuth()
      if (!fresh) {
        console.warn(
          `[gateway-credentials] ${provider} push 401 and refresh failed; giving up (will retry next launch)`,
        )
        return
      }
      res = await tryOnce(fresh)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(
        `[gateway-credentials] ${provider} push failed status=${res.status} body=${body.slice(0, 200)}`,
      )
      return
    }
    console.log(`[gateway-credentials] ${provider} key pushed to gateway`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-credentials] ${provider} push failed err=${msg}`)
  }
}

/** Back-compat shim for callers still importing pushAnthropicKey. */
export const pushAnthropicKey = (value: string): Promise<void> =>
  pushProviderKey('anthropic', value)

/** New: Deepgram push, mirrors pushAnthropicKey. */
export const pushDeepgramKey = (value: string): Promise<void> =>
  pushProviderKey('deepgram', value)

/**
 * On desktop launch, push any locally-stored provider keys to the
 * gateway. Idempotent (gateway upserts by user_id+provider), so safe to
 * run on every boot — also self-heals drift if the gateway was wiped or
 * the desktop key was rotated while offline.
 *
 * Runs in the background — does not block app startup.
 */
export function backfillProviderKeysOnLaunch(): void {
  // Defer until after the main thread settles so we don't compete with
  // the SyncAgent's first tick and other startup work.
  setTimeout(() => {
    const claudeKey = getCredential('claudeApiKey')
    if (claudeKey) void pushAnthropicKey(claudeKey)

    const deepgramKey = getCredential('deepgramApiKey')
    if (deepgramKey) void pushDeepgramKey(deepgramKey)
  }, 2000)
}

/** Back-compat shim for callers still importing the old name. */
export const backfillAnthropicKeyOnLaunch = backfillProviderKeysOnLaunch
