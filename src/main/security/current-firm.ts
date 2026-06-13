import { getCyggieAccessTokenSync } from '../auth/cyggie-auth-storage'

/**
 * Read `firm_id` out of the cached gateway access token (a HS256 JWT).
 *
 * The gateway signs `firm_id` into every access token (see
 * api-gateway/src/auth/jwt.ts); it is null until the user completes firm
 * onboarding. We only decode the payload — no signature check — because this is
 * our own already-trusted token and the value is used solely to scope a
 * best-effort config push / share stamp. Returns null when signed out, when the
 * token is malformed, or before onboarding.
 */
export function getCurrentFirmId(): string | null {
  const token = getCyggieAccessTokenSync()
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const claims = JSON.parse(json) as { firm_id?: unknown }
    return typeof claims.firm_id === 'string' && claims.firm_id.length > 0
      ? claims.firm_id
      : null
  } catch {
    return null
  }
}
