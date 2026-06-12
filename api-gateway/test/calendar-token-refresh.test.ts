// Integration tests for server-side Google token refresh on GET /calendar/events
// (the hotfix that stops the hourly REAUTH_REQUIRED lockout).
//
// We mock googleapis wholesale, so we DON'T simulate google-auth-library's
// internal refresh — we test the seams the gateway owns:
//   1. the decrypted refresh_token is handed to setCredentials (enables refresh)
//   2. invalid_grant → needs_reauth flipped, 401 GOOGLE_AUTH_FAILED
//   3. a transient Google error → needs_reauth UNTOUCHED, 502 GOOGLE_UNAVAILABLE
//   4. a legacy (SHA-256 hash) refresh token → needs_reauth flipped, REAUTH_REQUIRED
//   5. the 'tokens' persist callback updates access_token + expiry only,
//      leaving refresh_token_encrypted intact

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

// ─── Controllable googleapis mock ───────────────────────────────────────────
let listImpl: () => Promise<{ data: { items: unknown[] } }> = async () => ({ data: { items: [] } })
let lastCredentials: Record<string, unknown> | null = null
let lastTokensCallback: ((t: Record<string, unknown>) => void) | null = null

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(creds: Record<string, unknown>): void {
          lastCredentials = creds
        }
        on(event: string, cb: (t: Record<string, unknown>) => void): void {
          if (event === 'tokens') lastTokensCallback = cb
        }
      },
    },
    calendar: () => ({ events: { list: () => listImpl() } }),
  },
}))

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const { encryptToken } = await import('../src/auth/token-crypto')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-cal-refresh-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

beforeEach(() => {
  listImpl = async () => ({ data: { items: [] } })
  lastCredentials = null
  lastTokensCallback = null
})

async function setupUser(refreshTokenEncrypted: string): Promise<{ userId: string; token: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    displayName: userId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  await db.insert(schema.oauthTokens).values({
    id: TEST_PREFIX + 'oauth-' + createId().slice(0, 8),
    userId,
    provider: 'google',
    accessToken: 'fake-access-token',
    refreshTokenEncrypted,
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    needsReauth: false,
  })
  cleanup.track(schema.oauthTokens, schema.oauthTokens.userId, userId)
  const token = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
  return { userId, token }
}

function get(token: string) {
  return app.inject({
    method: 'GET',
    url: '/calendar/events',
    headers: { authorization: `Bearer ${token}` },
  })
}

async function reloadOauth(userId: string) {
  return db.query.oauthTokens.findFirst({ where: eq(schema.oauthTokens.userId, userId) })
}

describe('GET /calendar/events — server-side token refresh', () => {
  test('hands the decrypted refresh token to setCredentials', async () => {
    const { token } = await setupUser(encryptToken('the-refresh-token', env.GOOGLE_TOKEN_ENC_KEY))
    const res = await get(token)
    expect(res.statusCode).toBe(200)
    expect(lastCredentials?.refresh_token).toBe('the-refresh-token')
    expect(lastCredentials?.access_token).toBe('fake-access-token')
  })

  test('invalid_grant → flips needs_reauth and returns 401 GOOGLE_AUTH_FAILED', async () => {
    const { userId, token } = await setupUser(encryptToken('rt', env.GOOGLE_TOKEN_ENC_KEY))
    listImpl = async () => {
      throw Object.assign(new Error('invalid_grant'), {
        response: { data: { error: 'invalid_grant' } },
      })
    }
    const res = await get(token)
    expect(res.statusCode).toBe(401)
    const body = res.json() as { error: { code: string }; reauth_required?: boolean }
    expect(body.error.code).toBe('GOOGLE_AUTH_FAILED')
    expect(body.reauth_required).toBe(true)
    expect((await reloadOauth(userId))?.needsReauth).toBe(true)
  })

  test('transient Google error → keeps needs_reauth false and returns 502', async () => {
    const { userId, token } = await setupUser(encryptToken('rt', env.GOOGLE_TOKEN_ENC_KEY))
    listImpl = async () => {
      throw new Error('ETIMEDOUT connecting to googleapis.com')
    }
    const res = await get(token)
    expect(res.statusCode).toBe(502)
    const body = res.json() as { error: { code: string }; reauth_required?: boolean }
    expect(body.error.code).toBe('GOOGLE_UNAVAILABLE')
    expect(body.reauth_required).toBeUndefined()
    expect((await reloadOauth(userId))?.needsReauth).toBe(false)
  })

  test('legacy SHA-256 refresh token → flips needs_reauth and returns REAUTH_REQUIRED', async () => {
    const legacy = createHash('sha256').update('old-token').digest('hex')
    const { userId, token } = await setupUser(legacy)
    const res = await get(token)
    expect(res.statusCode).toBe(401)
    const body = res.json() as { error: { code: string } }
    expect(body.error.code).toBe('REAUTH_REQUIRED')
    expect((await reloadOauth(userId))?.needsReauth).toBe(true)
  })

  test("'tokens' persist updates access_token + expiry, leaves refresh token intact", async () => {
    const encrypted = encryptToken('keep-me', env.GOOGLE_TOKEN_ENC_KEY)
    const { userId, token } = await setupUser(encrypted)
    await get(token) // registers the 'tokens' listener
    expect(lastTokensCallback).toBeTypeOf('function')

    const newExpiry = Date.now() + 55 * 60 * 1000
    lastTokensCallback!({ access_token: 'refreshed-access', expiry_date: newExpiry })

    // Fire-and-forget write — poll until it lands.
    let row = await reloadOauth(userId)
    for (let i = 0; i < 20 && row?.accessToken !== 'refreshed-access'; i++) {
      await new Promise((r) => setTimeout(r, 25))
      row = await reloadOauth(userId)
    }
    expect(row?.accessToken).toBe('refreshed-access')
    expect(row?.accessTokenExpiresAt?.getTime()).toBe(newExpiry)
    // Refresh token must be untouched (still the original encrypted blob).
    expect(row?.refreshTokenEncrypted).toBe(encrypted)
  })
})
