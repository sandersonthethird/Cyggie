// MCP route smoke test (External Agents V1 slice 9 — OAuth path).
//
// Verifies the structural surface of POST /mcp end-to-end via app.inject:
//   1. Missing auth → 401 with MISSING_TOKEN envelope.
//   2. Non-Bearer auth → 401 with INVALID_TOKEN envelope.
//   3. Garbage Bearer → 401 with INVALID_TOKEN envelope.
//   4. Token missing required scope → 403 with INSUFFICIENT_SCOPE envelope.
//   5. Valid JWT (HS256-signed with the gateway secret, cyggie:read scope)
//      + JSON-RPC tools/list → returns exactly the 7 expected tools.
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
import type { FastifyInstance } from 'fastify'
import { SignJWT } from 'jose'
import { createSecretKey } from 'node:crypto'
import { mintTestToken as mintToken } from './_helpers/auth'
import { jsonRpc, parseJsonRpcResponse, callTool } from './_helpers/mcp'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'
process.env['CYGGIE_MCP_ENABLED'] = 'true'
// Slice 10 SQL tool is disabled by default in the test app boot to
// keep the tool catalog matching the 6 always-on tools. A dedicated
// describe() below toggles the flag via a separate buildApp.
process.env['CYGGIE_MCP_SQL_ENABLED'] = 'false'

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
  'cyggie_get_context',
] as const

// Thin wrapper over the shared minter (Issue 5A) that closes over this suite's
// loaded env so call sites stay terse.
const mintTestToken = (opts: Parameters<typeof mintToken>[1] = {}): Promise<string> =>
  mintToken(env.JWT_SIGNING_SECRET, opts)

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

  test('tools/list returns exactly the 7 expected tools', async () => {
    const res = await mcpCall(jsonRpc('tools/list'))
    expect(res.status).toBe(200)
    const reply = parseJsonRpcResponse(res.body) as {
      result?: { tools?: Array<{ name: string }> }
      error?: unknown
    }
    expect(reply.error).toBeUndefined()
    const names = (reply.result?.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
  })
})

describe('POST /mcp — per-tool smoke (validation + not-found, no seed)', () => {
  // These exercise the tools/call path end-to-end against the real DB, but
  // only the no-seed branches: input validation (INVALID_INPUT) and empty
  // result (NOT_FOUND). Auth uses the JWT `sub` directly as userId
  // (oauth-auth.ts) — no real user row required — so a query scoped to a
  // throwaway sub matches nothing and returns NOT_FOUND. The OK / AMBIGUOUS
  // branches (which need seeded companies/contacts/notes + cleanup) are a
  // separate seed-backed slice.
  let token: string
  beforeAll(async () => {
    token = await mintTestToken({ sub: `mcp-smoke-${Date.now().toString(36)}` })
  })

  test('cyggie_get_company returns NOT_FOUND for an unknown query', async () => {
    const result = await callTool(app, token, 'cyggie_get_company', { query: 'no-such-company-xyzzy' })
    expect(result.isError).toBe(true)
    expect(result._meta?.code).toBe('NOT_FOUND')
  })

  test('cyggie_get_contact returns NOT_FOUND for an unknown query', async () => {
    const result = await callTool(app, token, 'cyggie_get_contact', { query: 'no-such-contact-xyzzy' })
    expect(result.isError).toBe(true)
    expect(result._meta?.code).toBe('NOT_FOUND')
  })

  test('cyggie_recent_meetings rejects both companyId AND contactId set', async () => {
    const result = await callTool(app, token, 'cyggie_recent_meetings', {
      companyId: 'co-x',
      contactId: 'ct-x',
    })
    expect(result.isError).toBe(true)
    expect(result._meta?.code).toBe('INVALID_INPUT')
  })

  test('cyggie_get_meeting returns NOT_FOUND for an invalid id', async () => {
    const result = await callTool(app, token, 'cyggie_get_meeting', { id: 'definitely-not-a-real-id' })
    expect(result.isError).toBe(true)
    expect(result._meta?.code).toBe('NOT_FOUND')
  })

  test('cyggie_get_notes returns INVALID_INPUT with no filter', async () => {
    const result = await callTool(app, token, 'cyggie_get_notes', {})
    expect(result.isError).toBe(true)
    expect(result._meta?.code).toBe('INVALID_INPUT')
  })
})

describe('POST /mcp — feature flag', () => {
  // Group B: a separate app boot with the emergency kill-switch off. The /mcp
  // route must not bind at all, so any request 404s cleanly.
  test('CYGGIE_MCP_ENABLED=false returns 404', async () => {
    const prev = process.env['CYGGIE_MCP_ENABLED']
    process.env['CYGGIE_MCP_ENABLED'] = 'false'
    let disabledApp: FastifyInstance | undefined
    try {
      disabledApp = await buildApp(loadEnv())
      await disabledApp.ready()
      const res = await disabledApp.inject({
        method: 'POST',
        url: '/mcp',
        payload: jsonRpc('tools/list'),
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      if (disabledApp) await disabledApp.close()
      if (prev === undefined) delete process.env['CYGGIE_MCP_ENABLED']
      else process.env['CYGGIE_MCP_ENABLED'] = prev
    }
  })
})
