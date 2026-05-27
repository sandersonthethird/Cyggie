import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// POST /auth/google/start now opportunistically reads `Authorization: Bearer
// <jwt>`. When a valid JWT is present, the gateway resolves the user's email
// from the DB and passes it as `login_hint` to Google's consent URL. Used by
// mobile's calendar "Reconnect Google" flow to steer the user back to their
// existing Google account.
//
// The endpoint stays publicly callable (sign-in.tsx calls it unauthenticated).
// Invalid/missing bearer → falls through to no login_hint, no 401.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-lh-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdStates: string[] = []

afterAll(async () => {
  if (createdStates.length > 0) {
    await db
      .delete(schema.oauthPending)
      .where(inArray(schema.oauthPending.state, createdStates))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function insertTestUser(email: string): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email,
    displayName: id,
  })
  createdUserIds.push(id)
  return id
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

describe('POST /auth/google/start — login_hint', () => {
  test('gw1: valid Bearer → authUrl contains login_hint=<user-email>', async () => {
    const email = `${TEST_PREFIX}gw1@example.com`
    const userId = await insertTestUser(email)
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      payload: { device_id: TEST_PREFIX + 'dev-gw1', device_label: 'gw1' },
    })

    expect(res.statusCode).toBe(200)
    const { authUrl, state } = res.json() as { authUrl: string; state: string }
    createdStates.push(state)

    const parsed = new URL(authUrl)
    expect(parsed.searchParams.get('login_hint')).toBe(email)
  })

  test('gw2: no Bearer → authUrl has no login_hint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: { 'content-type': 'application/json' },
      payload: { device_id: TEST_PREFIX + 'dev-gw2', device_label: 'gw2' },
    })

    expect(res.statusCode).toBe(200)
    const { authUrl, state } = res.json() as { authUrl: string; state: string }
    createdStates.push(state)

    const parsed = new URL(authUrl)
    expect(parsed.searchParams.has('login_hint')).toBe(false)
  })

  test('gw3: invalid Bearer → falls through (200 + no login_hint, not 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-a-real-jwt',
      },
      payload: { device_id: TEST_PREFIX + 'dev-gw3', device_label: 'gw3' },
    })

    expect(res.statusCode).toBe(200)
    const { authUrl, state } = res.json() as { authUrl: string; state: string }
    createdStates.push(state)

    const parsed = new URL(authUrl)
    expect(parsed.searchParams.has('login_hint')).toBe(false)
  })
})
