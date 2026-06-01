// MCP route smoke test (External Agents V1 slice 9 — OAuth path).
//
// Verifies the structural surface of POST /mcp end-to-end via app.inject:
//   1. Missing auth → 401 with MISSING_TOKEN envelope.
//   2. Non-Bearer auth → 401 with INVALID_TOKEN envelope.
//   3. Garbage Bearer → 401 with INVALID_TOKEN envelope.
//   4. Token missing required scope → 403 with INSUFFICIENT_SCOPE envelope.
//   5. Valid JWT (HS256-signed with the gateway secret, cyggie:read scope)
//      + JSON-RPC tools/list → returns exactly the 6 expected tools.
//
// Slice 9 swap: the smoke test mints its own short-lived JWT with the
// shape the OAuth server would issue. This sidesteps the full
// authorize+token round-trip (which would require a real Cyggie user
// session + browser interaction) while still exercising the same
// verifier the MCP route uses in production. A separate E2E test
// (api-gateway/test/oauth-e2e.test.ts) walks the full browser flow
// via Playwright — that's the contract-locking test slice 9 calls for;
// this file is the structural one that runs on every PR fast.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SignJWT } from 'jose'
import { createSecretKey } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'
process.env['CYGGIE_MCP_ENABLED'] = 'true'

const { loadEnv } = await import('../src/env')
const { buildApp } = await import('../src/app')

let app: FastifyInstance
let env: ReturnType<typeof loadEnv>

beforeAll(async () => {
  env = loadEnv()
  app = await buildApp(env)
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

const EXPECTED_TOOLS = [
  'cyggie_search',
  'cyggie_get_company',
  'cyggie_get_contact',
  'cyggie_recent_meetings',
  'cyggie_get_meeting',
  'cyggie_get_notes',
] as const

// Mint a JWT with the same shape the OAuth server issues (HS256, aud
// 'cyggie-mcp', sub + scope + firm_id claims). The MCP route verifies
// with the same secret, so this token is indistinguishable from one
// issued by /oauth/token end-to-end.
async function mintTestToken(opts: {
  sub?: string
  scope?: string
  firmId?: string | null
  expSeconds?: number
} = {}): Promise<string> {
  const key = createSecretKey(Buffer.from(env.JWT_SIGNING_SECRET, 'utf-8'))
  const now = Math.floor(Date.now() / 1000)
  const expSeconds = opts.expSeconds ?? 15 * 60
  return new SignJWT({
    scope: opts.scope ?? 'cyggie:read cyggie:ask',
    firm_id: opts.firmId === undefined ? 'test-firm' : opts.firmId,
    client_id: 'test-client',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub ?? 'test-user')
    .setIssuer('http://127.0.0.1:8443/oauth')
    .setAudience('cyggie-mcp')
    .setIssuedAt(now)
    .setExpirationTime(now + expSeconds)
    .sign(key)
}

function jsonRpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params }
}

describe('POST /mcp — auth surface (slice 9 OAuth)', () => {
  test('rejects requests with no Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('MISSING_TOKEN')
  })

  test('rejects requests with a non-Bearer Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic abc',
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_TOKEN')
  })

  test('rejects requests with a garbage bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-a-real-jwt',
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_TOKEN')
  })

  test('rejects a JWT signed with the wrong secret', async () => {
    const wrongKey = createSecretKey(Buffer.from('a'.repeat(32), 'utf-8'))
    const now = Math.floor(Date.now() / 1000)
    const badJwt = await new SignJWT({ scope: 'cyggie:read' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('test-user')
      .setAudience('cyggie-mcp')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(wrongKey)
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${badJwt}`,
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_TOKEN')
  })

  test('rejects an expired JWT with EXPIRED_TOKEN code', async () => {
    const token = await mintTestToken({ expSeconds: -60 })
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('EXPIRED_TOKEN')
  })

  test('rejects a JWT with the wrong audience', async () => {
    const key = createSecretKey(Buffer.from(env.JWT_SIGNING_SECRET, 'utf-8'))
    const now = Math.floor(Date.now() / 1000)
    const wrongAudJwt = await new SignJWT({ scope: 'cyggie:read' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('test-user')
      .setAudience('wrong-audience')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key)
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${wrongAudJwt}`,
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('INVALID_TOKEN')
  })

  test('rejects a token missing required cyggie:read scope', async () => {
    const token = await mintTestToken({ scope: 'cyggie:sql' })
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: jsonRpc('tools/list'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('INSUFFICIENT_SCOPE')
    expect(res.headers['www-authenticate']).toContain('insufficient_scope')
  })
})

describe('POST /mcp — protocol surface (valid OAuth JWT)', () => {
  let token: string
  beforeAll(async () => {
    token = await mintTestToken({ scope: 'cyggie:read cyggie:ask' })
  })

  async function mcpCall(payload: unknown): Promise<{ status: number; body: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
    })
    return { status: res.statusCode, body: res.body }
  }

  function parseJsonRpcResponse(body: string): {
    result?: { tools?: Array<{ name: string }> }
    error?: { code: number; message: string }
  } {
    try {
      const parsed = JSON.parse(body)
      return Array.isArray(parsed) ? parsed[0] : parsed
    } catch {
      const m = /^data:\s*(.+)$/m.exec(body)
      if (!m) throw new Error(`Cannot parse MCP response: ${body.slice(0, 200)}`)
      const parsed = JSON.parse(m[1])
      return Array.isArray(parsed) ? parsed[0] : parsed
    }
  }

  test('tools/list returns exactly the 6 expected tools', async () => {
    const res = await mcpCall(jsonRpc('tools/list'))
    expect(res.status).toBe(200)
    const reply = parseJsonRpcResponse(res.body)
    expect(reply.error).toBeUndefined()
    const names = (reply.result?.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
  })
})

describe('POST /mcp — per-tool smoke (DB-dependent, currently deferred)', () => {
  test.skip('cyggie_search returns a sectioned markdown result', () => {})
  test.skip('cyggie_get_company returns AMBIGUOUS / NOT_FOUND / OK envelope', () => {})
  test.skip('cyggie_get_contact returns AMBIGUOUS / NOT_FOUND / OK envelope', () => {})
  test.skip('cyggie_recent_meetings rejects both companyId AND contactId set', () => {})
  test.skip('cyggie_get_meeting returns NOT_FOUND for an invalid id', () => {})
  test.skip('cyggie_get_notes returns INVALID_INPUT with no filter', () => {})
})

describe('POST /mcp — feature flag', () => {
  test.skip('CYGGIE_MCP_ENABLED=false returns 404 (deferred — needs separate app boot)', () => {})
})
