import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// POST /meetings/impromptu — pre-create an impromptu meeting (no audio) so the
// mobile client's on-device meeting id exists on the gateway and notes/
// attendees/companies become editable mid-recording. Idempotent upsert keyed
// on the client-supplied id, scoped to the caller.
//
// Coverage:
//   • client id → 201, row created (status='recording', wasImpromptu, id kept)
//   • repeat with same id → 200 (idempotent), no duplicate
//   • no id → server-mints → 201
//   • another user's id → 409 (never touch/return a foreign row)
//   • malformed id → 400

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

const TEST_PREFIX = `test-impromptu-create-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: null,
    role: 'member',
  })
  return { userId, jwt }
}

function post(jwt: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/meetings/impromptu',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })
}

describe('POST /meetings/impromptu', () => {
  test('client id → 201, row created with that exact id (id stability)', async () => {
    const { userId, jwt } = await setupUser()
    const id = createId()
    const res = await post(jwt, { id, title: 'Impromptu A' })
    expect(res.statusCode).toBe(201)
    const out = res.json() as { id: string; status: string; wasImpromptu: boolean }
    cleanup.track(schema.meetings, schema.meetings.id, id)
    expect(out.id).toBe(id)
    expect(out.status).toBe('recording')
    expect(out.wasImpromptu).toBe(true)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, id) })
    expect(row?.userId).toBe(userId)
    expect(row?.recordingPath).toBeNull() // no audio yet
  })

  test('repeat with the same id → 200 idempotent, no duplicate', async () => {
    const { jwt } = await setupUser()
    const id = createId()
    const first = await post(jwt, { id, title: 'Dup test' })
    expect(first.statusCode).toBe(201)
    cleanup.track(schema.meetings, schema.meetings.id, id)
    const second = await post(jwt, { id, title: 'Dup test (retry)' })
    expect(second.statusCode).toBe(200)
    expect((second.json() as { id: string }).id).toBe(id)
  })

  test('no id → server-mints → 201', async () => {
    const { jwt } = await setupUser()
    const res = await post(jwt, { title: 'No id provided' })
    expect(res.statusCode).toBe(201)
    const out = res.json() as { id: string }
    expect(out.id).toBeTruthy()
    cleanup.track(schema.meetings, schema.meetings.id, out.id)
  })

  test("another user's id → 409, foreign row untouched", async () => {
    const owner = await setupUser()
    const attacker = await setupUser()
    const id = createId()
    const created = await post(owner.jwt, { id, title: "Owner's" })
    expect(created.statusCode).toBe(201)
    cleanup.track(schema.meetings, schema.meetings.id, id)

    const res = await post(attacker.jwt, { id, title: 'Attacker' })
    expect(res.statusCode).toBe(409)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, id) })
    expect(row?.userId).toBe(owner.userId)
    expect(row?.title).toBe("Owner's")
  })

  test('malformed id → 400', async () => {
    const { jwt } = await setupUser()
    const res = await post(jwt, { id: 'NOT valid!!', title: 'x' })
    expect(res.statusCode).toBe(400)
  })
})
