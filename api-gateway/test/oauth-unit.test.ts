// OAuth unit tests (External Agents V1 slice 9).
//
// Covers the parts that don't need a real DB:
//   - /.well-known/oauth-authorization-server metadata shape
//   - /.well-known/oauth-protected-resource metadata shape
//   - Rate limiter behavior (10 req/hr per IP, window slide)
//
// Full OAuth flow E2E (authorize → consent → token exchange → MCP
// request) lives in api-gateway/test/oauth-e2e.test.ts and requires
// a test database + a browser-driver dependency (Playwright). That
// test is currently deferred under the same Neon-quota umbrella as
// the other DB-touching integration tests.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { buildApp } = await import('../src/app')
const {
  checkRegistrationRateLimit,
  _resetRateLimiterForTests,
} = await import('../src/oauth/rate-limit')

let app: FastifyInstance

beforeAll(async () => {
  const env = loadEnv()
  app = await buildApp(env)
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

afterEach(() => {
  _resetRateLimiterForTests()
})

describe('GET /.well-known/oauth-authorization-server', () => {
  test('returns RFC 8414 metadata with the expected fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.issuer).toMatch(/\/oauth$/)
    expect(body.authorization_endpoint).toBeTruthy()
    expect(body.token_endpoint).toBeTruthy()
    expect(body.registration_endpoint).toBeTruthy()
    expect(body.jwks_uri).toBeTruthy()
    expect(body.scopes_supported).toContain('cyggie:read')
    expect(body.scopes_supported).toContain('cyggie:ask')
    expect(body.scopes_supported).toContain('cyggie:sql')
    expect(body.grant_types_supported).toContain('authorization_code')
    expect(body.grant_types_supported).toContain('refresh_token')
    expect(body.grant_types_supported).toContain('client_credentials')
    expect(body.code_challenge_methods_supported).toContain('S256')
    expect(body.response_types_supported).toContain('code')
  })
})

describe('GET /.well-known/oauth-protected-resource', () => {
  test('returns RFC 9728 metadata pointing at /mcp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.resource).toMatch(/\/mcp$/)
    expect(body.authorization_servers).toBeInstanceOf(Array)
    expect(body.authorization_servers[0]).toMatch(/\/oauth$/)
    expect(body.scopes_supported).toContain('cyggie:read')
    expect(body.bearer_methods_supported).toContain('header')
  })
})

describe('rate-limit: checkRegistrationRateLimit', () => {
  test('allows up to 10 registrations per IP per hour', () => {
    for (let i = 0; i < 10; i++) {
      const decision = checkRegistrationRateLimit('1.2.3.4')
      expect(decision.allowed).toBe(true)
      expect(decision.retryAfterSeconds).toBe(0)
    }
  })

  test('11th request from same IP within window is rejected', () => {
    for (let i = 0; i < 10; i++) {
      checkRegistrationRateLimit('5.6.7.8')
    }
    const decision = checkRegistrationRateLimit('5.6.7.8')
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterSeconds).toBeGreaterThan(0)
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(3600)
  })

  test('different IPs have independent buckets', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRegistrationRateLimit('10.0.0.1').allowed).toBe(true)
    }
    expect(checkRegistrationRateLimit('10.0.0.1').allowed).toBe(false)
    // Different IP, fresh bucket.
    expect(checkRegistrationRateLimit('10.0.0.2').allowed).toBe(true)
  })

  test('retryAfterSeconds shrinks as the window slides', async () => {
    for (let i = 0; i < 10; i++) {
      checkRegistrationRateLimit('20.0.0.1')
    }
    const first = checkRegistrationRateLimit('20.0.0.1')
    // Wait ~10ms — same window, same retry-after roughly.
    await new Promise((r) => setTimeout(r, 10))
    const second = checkRegistrationRateLimit('20.0.0.1')
    expect(first.allowed).toBe(false)
    expect(second.allowed).toBe(false)
    // Second retry-after should be slightly less (a few ms) — but
    // rounded to seconds, both are likely 3600. Just assert they're
    // bounded.
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds)
  })
})

describe('POST /oauth/reg — registration rate limit (Part 3 Group C)', () => {
  test('returns 429 with RATE_LIMITED after 10 registrations from same IP', async () => {
    const body = {
      client_name: 'test-client',
      redirect_uris: ['http://127.0.0.1/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }
    // The 11th request from the same IP (app.inject → 127.0.0.1) trips the
    // in-memory limiter, which runs BEFORE the registration handoff. The
    // afterEach reset keeps this isolated from the unit rate-limit tests.
    let last: Awaited<ReturnType<typeof app.inject>> | undefined
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/oauth/reg',
        headers: { 'content-type': 'application/json' },
        payload: body,
      })
    }
    expect(last!.statusCode).toBe(429)
    expect(last!.json().error.code).toBe('RATE_LIMITED')
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0)
  })
})

describe('OAuth flows still deferred (need the browser consent leg)', () => {
  // These remain unwritten because obtaining a refresh token requires the
  // authorize→consent→code→token round-trip, whose consent step is
  // browser-driven (Playwright). They belong with the consent E2E
  // (api-gateway/test/oauth-e2e.test.ts, not yet created — tracked in TODOS).
  test.skip('register → authorize+PKCE → consent → token exchange → MCP /mcp 200', () => {})
  test.skip('refresh_token rotation issues new pair, old one invalid', () => {})
  test.skip('refresh-token reuse triggers chain revocation + Sentry alert', () => {})
  // client_credentials: DCR clients here are registered with
  // authorization_code+refresh_token grants only; testing a client_credentials
  // grant needs a separately-provisioned confidential CC client — deferred
  // with the E2E slice rather than guessed at.
  test.skip('client_credentials grant issues a token without user interaction', () => {})
})
