// =============================================================================
// jwt.ts — minimal access-token introspection.
//
// We only need the access token's `exp` to decide whether to refresh
// PROACTIVELY at app launch, so the first authed request doesn't pay a
// 401 → /auth/refresh → retry round-trip. This does NOT verify the signature —
// that's the gateway's job; we just read the (unverified) payload to time a
// refresh. The access token lives un-gated in SecureStore, so reading its exp
// is cheap and never triggers the Face-ID-gated refresh-token read.
// =============================================================================

interface JwtPayload {
  exp?: number // seconds since epoch (standard JWT claim)
}

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  // atob is available in Hermes (RN) and Node 16+ (vitest/jest).
  return atob(padded)
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload
  } catch {
    return null
  }
}

/**
 * True when the token is missing, unparseable, has no `exp`, or expires within
 * `skewMs` from now. Biased toward `true` on any uncertainty so we refresh
 * rather than risk a first-request 401.
 */
export function accessTokenExpiringWithin(token: string | null, skewMs: number): boolean {
  if (!token) return true
  const payload = decodeJwtPayload(token)
  if (!payload?.exp) return true
  return payload.exp * 1000 <= Date.now() + skewMs
}
