import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// POST /devices/register-push — stores the APNs device token on the caller's
// session row so transcribe-job can push to it later.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
if (!process.env['DEEPGRAM_API_KEY']) process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key'
if (!process.env['DEEPGRAM_WEBHOOK_SECRET'])
  process.env['DEEPGRAM_WEBHOOK_SECRET'] = 'test-webhook-secret-at-least-16-chars'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-devreg-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdSessionIds: string[] = []

afterAll(async () => {
  if (createdSessionIds.length > 0) {
    await db.delete(schema.sessions).where(inArray(schema.sessions.id, createdSessionIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function insertUserAndSession(): Promise<{ userId: string; sessionId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const sessionId = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  createdUserIds.push(userId)
  await db.insert(schema.sessions).values({
    id: sessionId,
    userId,
    deviceId: 'test-device',
    refreshTokenHash: 'hash-' + sessionId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })
  createdSessionIds.push(sessionId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: sessionId,
    device: 'test-device',
    scope: ['user'],
    firm_id: null,
    role: 'member',
  })
  return { userId, sessionId, jwt }
}

describe('POST /devices/register-push', () => {
  test('stores deviceToken + environment on the session row', async () => {
    const { sessionId, jwt } = await insertUserAndSession()
    const res = await app.inject({
      method: 'POST',
      url: '/devices/register-push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { deviceToken: 'a'.repeat(64), environment: 'sandbox' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const row = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    })
    expect(row?.apnsDeviceToken).toBe('a'.repeat(64))
    expect(row?.apnsEnvironment).toBe('sandbox')
    expect(row?.apnsTokenUpdatedAt).toBeInstanceOf(Date)
  })

  test('rejects requests without a JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/register-push',
      headers: { 'content-type': 'application/json' },
      payload: { deviceToken: 'b'.repeat(64), environment: 'sandbox' },
    })
    expect(res.statusCode).toBe(401)
  })

  test('rejects payload with missing/invalid fields', async () => {
    const { jwt } = await insertUserAndSession()
    const res = await app.inject({
      method: 'POST',
      url: '/devices/register-push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { deviceToken: 'short', environment: 'sandbox' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('updates the token in place on a second register (token rotation)', async () => {
    const { sessionId, jwt } = await insertUserAndSession()
    await app.inject({
      method: 'POST',
      url: '/devices/register-push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { deviceToken: 'a'.repeat(64), environment: 'sandbox' },
    })
    await app.inject({
      method: 'POST',
      url: '/devices/register-push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { deviceToken: 'b'.repeat(64), environment: 'production' },
    })
    const row = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    })
    expect(row?.apnsDeviceToken).toBe('b'.repeat(64))
    expect(row?.apnsEnvironment).toBe('production')
  })
})
