// Dev-only MCP authentication.
//
// Slice 8 ships a static-bearer-token shim so MCP Inspector / Claude
// Desktop / curl can hit POST /mcp during development. Slice 9 replaces
// this with a real OAuth 2.0 verification path against node-oidc-provider.
//
// This module deliberately has no production code path — when
// CYGGIE_MCP_DEV_TOKEN is unset, every request fails closed. The slice
// 8 README warns against shipping the dev token to prod. Slice 9 will
// delete this file entirely.

import type { FastifyRequest } from 'fastify'
import type { GatewayEnv } from '../env'

export interface McpDevAuthResult {
  ok: true
  // Slice 8 stub: there's no real user identity yet (no OAuth), so we
  // use a fixed dev user id. Slice 9 derives userId from the OAuth
  // access token's `sub` claim. Until then, the dev token impersonates
  // whichever user the operator has configured.
  userId: string
}

export interface McpDevAuthFail {
  ok: false
  statusCode: 401
  errorCode: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'AUTH_NOT_CONFIGURED'
  message: string
}

// Reads from `MCP_DEV_USER_ID` if set, else falls back to a deterministic
// placeholder. The placeholder makes integration tests deterministic
// while making it obvious this isn't a real user.
function devUserId(): string {
  return process.env['MCP_DEV_USER_ID'] ?? 'mcp-dev-user'
}

export function verifyDevToken(
  req: FastifyRequest,
  env: GatewayEnv,
): McpDevAuthResult | McpDevAuthFail {
  if (!env.CYGGIE_MCP_DEV_TOKEN) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'AUTH_NOT_CONFIGURED',
      message:
        'MCP authentication not configured. Set CYGGIE_MCP_DEV_TOKEN in dev or wait for slice 9 OAuth.',
    }
  }

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

  const presented = m[1].trim()
  if (!constantTimeEqual(presented, env.CYGGIE_MCP_DEV_TOKEN)) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: 'INVALID_TOKEN',
      message: 'Bearer token does not match CYGGIE_MCP_DEV_TOKEN.',
    }
  }

  return { ok: true, userId: devUserId() }
}

// Constant-time string compare — defends against timing attacks on
// short bearer-token validation. Standard impl: XOR each byte, OR
// results, return 0 == equal. Always processes full length.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Length mismatch is a fast-fail. The token is fixed-length once
    // the operator picks one, so this only differs by length when
    // someone's mistyped — not when guessing a real-format token.
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
