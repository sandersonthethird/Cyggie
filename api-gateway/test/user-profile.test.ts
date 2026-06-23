import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// PATCH /user/profile (T25) — desktop pushes identity fields to Neon so the
// enhance route can build the summarizer's task-attribution context.

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

const TEST_PREFIX = `test-profile-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

let userId: string
beforeEach(async () => {
  userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    displayName: 'Sandy Cass',
  })
  cleanup.track(schema.users, schema.users.id, userId)
})

async function mintJwt(uid: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: uid,
    sid: TEST_PREFIX + 'sess-' + uid,
    device: TEST_PREFIX + 'dev',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

async function patchProfile(uid: string, body: unknown) {
  return app.inject({
    method: 'PATCH',
    url: '/user/profile',
    headers: { authorization: `Bearer ${await mintJwt(uid)}` },
    payload: body,
  })
}

async function readUser(uid: string) {
  return db.query.users.findFirst({ where: eq(schema.users.id, uid) })
}

describe('PATCH /user/profile', () => {
  test('persists all four identity fields', async () => {
    const res = await patchProfile(userId, {
      firstName: 'Sandy',
      lastName: 'Cass',
      title: 'Partner',
      jobFunction: 'Investing',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const row = await readUser(userId)
    expect(row?.firstName).toBe('Sandy')
    expect(row?.lastName).toBe('Cass')
    expect(row?.title).toBe('Partner')
    expect(row?.jobFunction).toBe('Investing')
  })

  test('omitted fields are left untouched (PATCH semantics)', async () => {
    await patchProfile(userId, { firstName: 'Sandy', title: 'Partner' })
    await patchProfile(userId, { lastName: 'Cass' }) // omits firstName/title
    const row = await readUser(userId)
    expect(row?.firstName).toBe('Sandy') // preserved
    expect(row?.title).toBe('Partner') // preserved
    expect(row?.lastName).toBe('Cass') // newly set
  })

  test('explicit null clears a field', async () => {
    await patchProfile(userId, { title: 'Partner' })
    await patchProfile(userId, { title: null })
    const row = await readUser(userId)
    expect(row?.title).toBeNull()
  })

  test('requires auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/user/profile',
      payload: { firstName: 'X' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
  })
})
