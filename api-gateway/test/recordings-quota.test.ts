import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Per-user monthly minutes cap on POST /recordings/upload.
//
// The handler does the quota check BEFORE multipart parsing, so an over-cap
// request short-circuits with 403 regardless of whether the audio body is
// well-formed.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
// Pin the quota low so we don't have to insert 600 minutes of fake data.
process.env['RECORDING_QUOTA_MONTHLY_MINUTES'] = '5'

// Force-required env vars that aren't set in .env.local for non-recording tests.
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

const TEST_PREFIX = `test-quota-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

// /recordings/upload now uses requireFirm() — the quota gate runs AFTER auth,
// so a firm-less token would 403 NO_FIRM before reaching the QUOTA_EXCEEDED
// path these tests assert. Give each user a real (shared) firm.
const SHARED_FIRM_ID = TEST_PREFIX + 'firm'

async function insertUserWithUsage(usedMinutes: number): Promise<string> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db
    .insert(schema.firms)
    .values({ id: SHARED_FIRM_ID, name: 'Quota Test Firm', slug: SHARED_FIRM_ID })
    .onConflictDoNothing()
  cleanup.track(schema.firms, schema.firms.id, SHARED_FIRM_ID)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    firmId: SHARED_FIRM_ID,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  if (usedMinutes > 0) {
    const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
    await db.insert(schema.meetings).values({
      id: meetingId,
      userId,
      title: 'Existing usage',
      date: new Date(),
      durationSeconds: usedMinutes * 60,
      status: 'transcribed',
    })
    cleanup.track(schema.meetings, schema.meetings.id, meetingId)
  }
  return userId
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: SHARED_FIRM_ID,
    role: 'member',
  })
}

describe('POST /recordings/upload — quota', () => {
  test('over-cap user gets 403 QUOTA_EXCEEDED', async () => {
    const userId = await insertUserWithUsage(5) // exact cap
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'multipart/form-data; boundary=---test',
      },
      // Body irrelevant — quota check runs before multipart parse.
      payload: '---test--\r\n',
    })
    expect(res.statusCode).toBe(403)
    const body = res.json() as { error?: { code?: string } }
    expect(body.error?.code).toBe('QUOTA_EXCEEDED')
  })

  test('under-cap user passes the quota gate (and then fails for other reasons — not 403)', async () => {
    // Insert a user with no prior usage. The upload still fails (because the
    // multipart body is empty/garbage), but the response code must NOT be 403.
    const userId = await insertUserWithUsage(0)
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'multipart/form-data; boundary=---test',
      },
      payload: '---test--\r\n',
    })
    expect(res.statusCode).not.toBe(403)
  })

  test('over-cap rejection happens before any DB insert of a new meeting', async () => {
    const userId = await insertUserWithUsage(5)
    const jwt = await mintJwt(userId)
    // Scope the before/after count to THIS test user — the dev Neon DB has
    // unrelated rows; an unbounded query against meetings would time out.
    const before = await db.query.meetings.findMany({
      where: (m, { eq }) => eq(m.userId, userId),
    })
    await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'multipart/form-data; boundary=---test',
      },
      payload: '---test--\r\n',
    })
    const after = await db.query.meetings.findMany({
      where: (m, { eq }) => eq(m.userId, userId),
    })
    expect(after.length).toBe(before.length)
  })
})
