// OAuth bearer-token authentication for the MCP route (slice 9).
//
// Replaces the slice 8 dev-bypass (dev-auth.ts). Verifies the JWT
// access token issued by the OAuth server using the same HS256 secret
// the rest of the gateway uses for its own session JWTs.
//
// The MCP route hands every request through this function before
// dispatching to the tool runtime. A valid token yields { userId,
// firmId, scopes } that the route uses to set per-request audit
// context and (in a future slice) scope-gate specific tools.

import type { FastifyRequest } from 'fastify'
import { jwtVerify } from 'jose'
import { createSecretKey } from 'node:crypto'
import type { GatewayEnv } from '../env'

export interface McpOAuthAuthResult {
  ok: true
  userId: string
  firmId: string | null
  scopes: string[]
  clientId: string | null
}

export interface McpOAuthAuthFail {
  ok: false
  statusCode: 401 | 403
  errorCode: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'INSUFFICIENT_SCOPE'
  message: string
}

export async function verifyOAuthBearer(
  req: FastifyRequest,
  env: GatewayEnv,
  options: { requiredScopes?: string[] } = {},
): Promise<McpOAuthAuthResult | McpOAuthAuthFail> {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string') {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'MISSING_TOKEN',
      message: 'Missing Authorization header.',
    }
  }
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'INVALID_TOKEN',
      message: 'Authorization header must be `Bearer <token>`.',
    }
  }

  const token = m[1].trim()
  const key = createSecretKey(Buffer.from(env.JWT_SIGNING_SECRET, 'utf-8'))

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    const verified = await jwtVerify(token, key, {
      // The OAuth server signs JWTs with `aud: 'cyggie-mcp'` per the
      // resource-indicator config in provider.ts. Reject tokens issued
      // for a different audience (e.g. a future cyggie-something-else).
      audience: 'cyggie-mcp',
    })
    payload = verified.payload
  } catch (err) {
    const isExpired =
      err instanceof Error && err.name === 'JWTExpired'
    return {
      ok: false,
      statusCode: 401,
      errorCode: isExpired ? 'EXPIRED_TOKEN' : 'INVALID_TOKEN',
      message: isExpired
        ? 'Access token has expired. Refresh and retry.'
        : 'Access token failed validation.',
    }
  }

  // Required claims:
  //   sub        — user id (authorization_code) or client id (client_credentials)
  //   scope      — space-separated scope string per RFC 6749
  //   firm_id    — copied from the user record by findAccount (may be null
  //                for client_credentials tokens that don't have a user)
  //   client_id  — client that received this token
  const sub = typeof payload.sub === 'string' ? payload.sub : null
  const scopeStr = typeof payload['scope'] === 'string' ? payload['scope'] : ''
  const scopes = scopeStr.split(/\s+/).filter(Boolean)
  const firmId =
    typeof payload['firm_id'] === 'string' ? payload['firm_id'] : null
  const clientId =
    typeof payload['client_id'] === 'string'
      ? payload['client_id']
      : typeof payload['azp'] === 'string'
        ? payload['azp']
        : null

  if (!sub) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'INVALID_TOKEN',
      message: 'Token missing required `sub` claim.',
    }
  }

  if (options.requiredScopes && options.requiredScopes.length > 0) {
    const missing = options.requiredScopes.filter((s) => !scopes.includes(s))
    if (missing.length > 0) {
      return {
        ok: false,
        statusCode: 403,
        errorCode: 'INSUFFICIENT_SCOPE',
        message: `Token lacks required scope(s): ${missing.join(', ')}.`,
      }
    }
  }

  return {
    ok: true,
    userId: sub,
    firmId,
    scopes,
    clientId,
  }
}
