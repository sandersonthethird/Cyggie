import { jwtVerify, SignJWT } from 'jose'
import { GatewayError } from '../plugins/error'

// JWT issuance + verification. Per plan-ceo-review §6:
//   • Access token: 15 min lifetime, HS256 signed with JWT_SIGNING_SECRET
//   • Refresh token: 30 days, rotated on use; lives in sessions table (hashed)
//
// Claims:
//   sub      — users.id (cuid2)
//   sid      — sessions.id (rotated on refresh, anchors to the device row)
//   device   — device_id (stable per-device identifier)
//   scope    — array of capability strings; V1 just 'user'
//   firm_id  — users.firm_id; null until the user completes onboarding
//             (Flow A create-workspace, Flow B accept-invite, Flow C auto-join).
//             Downstream routes that require a tenant context call
//             req.requireFirm() which 403s on null.
//   role     — 'admin' | 'member'. First-from-firm becomes admin; invitees
//             default to member. Admin-only routes check this.
//   iat, exp — standard
//
// firm_id is refreshed on the next /auth/refresh after a tenant transition
// (the refresh path reads the current user row, not the old JWT) so the
// short access-token TTL keeps the claim from going stale.

export type UserRole = 'admin' | 'member'

export interface AccessTokenClaims {
  sub: string
  sid: string
  device: string
  scope: string[]
  firm_id: string | null
  role: UserRole
}

const ISSUER = 'cyggie-gateway'
const AUDIENCE = 'cyggie-client'
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60 // 15 min

let _signingKey: Uint8Array | null = null
function getSigningKey(secret: string): Uint8Array {
  if (!_signingKey) {
    _signingKey = new TextEncoder().encode(secret)
  }
  return _signingKey
}

export async function signAccessToken(
  secret: string,
  claims: AccessTokenClaims,
): Promise<string> {
  return new SignJWT({
    device: claims.device,
    scope: claims.scope,
    sid: claims.sid,
    firm_id: claims.firm_id,
    role: claims.role,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getSigningKey(secret))
}

export async function verifyAccessToken(
  secret: string,
  token: string,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, getSigningKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    if (
      typeof payload.sub !== 'string' ||
      typeof payload['sid'] !== 'string' ||
      typeof payload['device'] !== 'string' ||
      !Array.isArray(payload['scope'])
    ) {
      throw new GatewayError({
        statusCode: 401,
        code: 'INVALID_TOKEN',
        message: 'Token payload malformed',
      })
    }
    // firm_id is allowed to be null (pre-onboarding); role must be a string.
    const rawFirmId = payload['firm_id']
    const firm_id =
      rawFirmId === null || rawFirmId === undefined
        ? null
        : typeof rawFirmId === 'string'
          ? rawFirmId
          : null
    const rawRole = payload['role']
    const role: UserRole = rawRole === 'admin' ? 'admin' : 'member'
    return {
      sub: payload.sub,
      sid: payload['sid'] as string,
      device: payload['device'] as string,
      scope: payload['scope'] as string[],
      firm_id,
      role,
    }
  } catch (err) {
    if (err instanceof GatewayError) throw err
    const msg = err instanceof Error ? err.message : 'token verification failed'
    throw new GatewayError({
      statusCode: 401,
      code: 'INVALID_TOKEN',
      message: msg,
    })
  }
}
