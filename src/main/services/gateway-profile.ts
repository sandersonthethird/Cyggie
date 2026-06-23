import { getAccessToken, refresh as refreshCyggieAuth } from '../auth/cyggie-auth'
import { getCurrentUserProfile } from '../security/current-user'

// T25 — desktop → gateway user-profile push.
//
// The summarizer's task-attribution context needs the user's identity
// (firstName/lastName/title/jobFunction). Desktop owns these (edited in
// Settings, stored in local SQLite). The Neon `users` table only had
// displayName/email until the 0045 migration added the four identity
// columns. This module pushes them to PATCH /user/profile so the gateway's
// enhance route can build the SAME task-attribution prompt the desktop
// summarizer does (a gateway-enhanced meeting then matches a desktop one).
//
// `users` is intentionally OUTSIDE the outbox (auth/identity metadata, not
// owned content), so this uses the same dedicated-push + 401→refresh→retry
// pattern as gateway-credentials.ts. Best-effort: logs + swallows on failure;
// the next desktop launch backfills.

const GATEWAY_URL =
  process.env['CYGGIE_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

export interface ProfilePushFields {
  firstName: string | null
  lastName: string | null
  title: string | null
  jobFunction: string | null
}

/**
 * Push the user's identity fields to the gateway. Best-effort — does not
 * throw, only logs. Caller doesn't need to await.
 */
export async function pushUserProfile(fields: ProfilePushFields): Promise<void> {
  const tokenA = await getAccessToken()
  if (!tokenA) {
    console.log('[gateway-profile] no access token; skipping profile push')
    return
  }

  const tryOnce = (token: string): Promise<Response> =>
    fetch(`${GATEWAY_URL}/user/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(fields),
    })

  try {
    let res = await tryOnce(tokenA)
    if (res.status === 401) {
      const fresh = await refreshCyggieAuth()
      if (!fresh) {
        console.warn(
          '[gateway-profile] push 401 and refresh failed; giving up (will retry next launch)',
        )
        return
      }
      res = await tryOnce(fresh)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(
        `[gateway-profile] push failed status=${res.status} body=${body.slice(0, 200)}`,
      )
      return
    }
    console.log('[gateway-profile] profile pushed to gateway')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[gateway-profile] push failed err=${msg}`)
  }
}

/**
 * On desktop launch, push the locally-stored profile identity fields to the
 * gateway. Idempotent (gateway UPDATEs the caller's own row), so safe on
 * every boot — self-heals drift if the gateway was wiped or the profile was
 * edited offline. Runs in the background; does not block startup.
 */
export function backfillUserProfileOnLaunch(): void {
  setTimeout(() => {
    try {
      const p = getCurrentUserProfile()
      void pushUserProfile({
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        jobFunction: p.jobFunction,
      })
    } catch (err) {
      // No current user yet (not signed in) — nothing to backfill.
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[gateway-profile] backfill skipped: ${msg}`)
    }
  }, 2500)
}
