import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { storeCredential, getCredential } from '../security/credentials'

// =============================================================================
// cyggie-auth-storage.ts — typed wrapper around the existing safeStorage-backed
// credentials.ts helpers. Holds the four artifacts the desktop SyncAgent needs:
//
//   ACCESS_TOKEN  — 15-min Cyggie JWT; written cleartext to safeStorage's
//                   keychain-protected blob. Read on every /sync/push.
//   REFRESH_TOKEN — 30-day rotation token; same protection. Read only by the
//                   refresh path.
//   USER_ID       — gateway's users.id; readable for status display and
//                   defense-in-depth in the wrapper.
//   USER_EMAIL    — display string for the Settings panel pill.
//
// An in-memory access-token cache avoids hitting safeStorage.decryptString on
// every /sync/push call (decrypt has measurable per-call cost; the agent can
// fire dozens of pushes during a typical edit session). Cache invalidates on
// refresh, sign-out, and on explicit `clearCache()` calls.
// =============================================================================

const ACCESS_TOKEN_KEY = 'cyggie_access_token'
const REFRESH_TOKEN_KEY = 'cyggie_refresh_token'
const USER_ID_KEY = 'cyggie_user_id'
const USER_EMAIL_KEY = 'cyggie_user_email'
// Durable mirror of the gateway id used by note ownership (see current-user.ts's
// GATEWAY_ID_SETTING). Deliberately NOT cleared on sign-out, and stored as a
// plain setting (not a credential) — it's an identity, not a secret. String
// literal rather than an import to avoid a cycle with current-user.ts.
const GATEWAY_ID_SETTING = 'currentUserGatewayId'

let accessTokenCache: string | null = null

export interface CyggieTokens {
  accessToken: string
  refreshToken: string
  userId: string
  email: string
}

/** Persist the full token set after a successful sign-in or refresh. */
export function storeCyggieTokens(tokens: CyggieTokens): void {
  storeCredential(ACCESS_TOKEN_KEY, tokens.accessToken)
  storeCredential(REFRESH_TOKEN_KEY, tokens.refreshToken)
  // user_id + email don't strictly need encryption (they're surfaced in UI
  // and logs), but going through the same path keeps the layout uniform.
  storeCredential(USER_ID_KEY, tokens.userId)
  storeCredential(USER_EMAIL_KEY, tokens.email)
  // Durably mirror the gateway id so note ownership recognises gateway-stamped
  // rows as the user's own even after sign-out (USER_ID_KEY above is wiped on
  // sign-out; this one is not).
  settingsRepo.setSetting(GATEWAY_ID_SETTING, tokens.userId)
  accessTokenCache = tokens.accessToken
}

/**
 * Rotate just the access + refresh pair (called after /auth/refresh). user_id
 * and email don't change across refresh, so we leave them alone.
 */
export function storeCyggieRefreshedTokens(opts: {
  accessToken: string
  refreshToken: string
}): void {
  storeCredential(ACCESS_TOKEN_KEY, opts.accessToken)
  storeCredential(REFRESH_TOKEN_KEY, opts.refreshToken)
  accessTokenCache = opts.accessToken
}

/**
 * Read the access token. Returns the in-memory cached value when warm;
 * otherwise decrypts from safeStorage on first call. Returns null if the
 * user is not signed in.
 */
export function getCyggieAccessTokenSync(): string | null {
  if (accessTokenCache != null) return accessTokenCache
  const v = getCredential(ACCESS_TOKEN_KEY)
  if (v) accessTokenCache = v
  return v
}

export function getCyggieRefreshToken(): string | null {
  return getCredential(REFRESH_TOKEN_KEY)
}

export function getCyggieUserId(): string | null {
  return getCredential(USER_ID_KEY)
}

export function getCyggieUserEmail(): string | null {
  return getCredential(USER_EMAIL_KEY)
}

/**
 * Wipe all four artifacts. Called by signOut() and on persistent 401s. The
 * setSetting('') pattern is what credentials.ts callers use to clear (the
 * underlying settings table treats empty string the same as absent).
 */
export function clearCyggieTokens(): void {
  settingsRepo.setSetting(ACCESS_TOKEN_KEY, '')
  settingsRepo.setSetting(REFRESH_TOKEN_KEY, '')
  settingsRepo.setSetting(USER_ID_KEY, '')
  settingsRepo.setSetting(USER_EMAIL_KEY, '')
  accessTokenCache = null
}

/** Test seam: invalidate the in-memory cache without touching disk. */
export function _resetCacheForTesting(): void {
  accessTokenCache = null
}
