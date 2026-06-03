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

describe('OAuth E2E flow (DB-dependent, currently deferred)', () => {
  // Full flow requires:
  //   1. A real test DB (Neon quota currently blocks)
  //   2. Playwright + chromium for the browser-driven consent step
  //   3. A test Cyggie user with a server-side session cookie
  //
  // Each is bounded engineering work but adds runtime to CI. Defer until
  // Neon quota issue resolved, then bring up the full suite in one PR
  // alongside the per-tool DB-touching tests.
  test.skip('register → authorize+PKCE → consent → token exchange → MCP /mcp 200', () => {})
  test.skip('refresh_token rotation issues new pair, old one invalid', () => {})
  test.skip('refresh-token reuse triggers chain revocation + Sentry alert', () => {})
  test.skip('client_credentials grant issues a token without user interaction', () => {})
  test.skip('/oauth/reg returns 429 after 10 registrations from same IP', () => {})
})
