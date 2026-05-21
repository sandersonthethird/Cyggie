import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// GET /sync/pull?since=<lamport> — mobile pulls deltas from Neon.
//
// Coverage:
//   • empty result when no meetings exist for the user
//   • since-filter: only meetings with lamport > since are returned
//   • user-scoping: meetings owned by other users are excluded
//   • ordering: rows come back ascending by lamport (BigInt-safe via numeric cast)
//   • serverLamport reflects the max lamport seen
//   • since=0 (or default) returns all rows (first-launch case)
//   • 401 when unauthenticated

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

const TEST_PREFIX = `test-pull-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdMeetingIds: string[] = []

afterAll(async () => {
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  createdUserIds.push(userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
  return { userId, jwt }
}

async function insertMeeting(userId: string, lamport: string): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title: `M-${lamport}`,
    date: new Date('2026-05-20T10:00:00Z'),
    status: 'scheduled',
    lamport,
    createdByUserId: userId,
  })
  createdMeetingIds.push(id)
  return id
}

describe('GET /sync/pull', () => {
  test('empty result when user has no meetings', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { meetings: unknown[]; serverLamport: string }
    expect(body.meetings).toEqual([])
    expect(body.serverLamport).toBe('0')
  })

  test('since=0 default returns all rows ascending by lamport', async () => {
    const { userId, jwt } = await setupUser()
    const idA = await insertMeeting(userId, '5')
    const idB = await insertMeeting(userId, '20')
    const idC = await insertMeeting(userId, '12')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ id: string; lamport: string }>
      serverLamport: string
    }
    expect(body.meetings.map((m) => m.id)).toEqual([idA, idC, idB])
    expect(body.meetings.map((m) => m.lamport)).toEqual(['5', '12', '20'])
    expect(body.serverLamport).toBe('20')
  })

  test('since-filter excludes rows with lamport <= since', async () => {
    const { userId, jwt } = await setupUser()
    await insertMeeting(userId, '5')
    const idB = await insertMeeting(userId, '15')
    await insertMeeting(userId, '10')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=10',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ id: string; lamport: string }>
      serverLamport: string
    }
    expect(body.meetings).toHaveLength(1)
    expect(body.meetings[0]?.id).toBe(idB)
    expect(body.serverLamport).toBe('15')
  })

  test('user-scoping — never returns other users meetings', async () => {
    const alice = await setupUser()
    const bob = await setupUser()
    await insertMeeting(alice.userId, '7')
    const bobMeetingId = await insertMeeting(bob.userId, '8')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${bob.jwt}` },
    })
    const body = res.json() as { meetings: Array<{ id: string; userId: string }> }
    expect(body.meetings).toHaveLength(1)
    expect(body.meetings[0]?.id).toBe(bobMeetingId)
    expect(body.meetings[0]?.userId).toBe(bob.userId)
  })

  test('BigInt-safe — lamport values beyond JS safe int compare numerically', async () => {
    const { userId, jwt } = await setupUser()
    // 2^53 = 9_007_199_254_740_992 — anything beyond is lossy in number form.
    // Lexicographic compare would put '9' > '10' which is wrong; we test the
    // numeric cast path by mixing widths.
    const small = await insertMeeting(userId, '9')
    const large = await insertMeeting(userId, '10000000000000000') // 10^16

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=8',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as { meetings: Array<{ id: string }>; serverLamport: string }
    expect(body.meetings.map((m) => m.id)).toEqual([small, large])
    expect(body.serverLamport).toBe('10000000000000000')
  })

  test('serverLamport stays at since when no rows match', async () => {
    const { userId, jwt } = await setupUser()
    await insertMeeting(userId, '3')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=100',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as { meetings: unknown[]; serverLamport: string }
    expect(body.meetings).toEqual([])
    expect(body.serverLamport).toBe('100')
  })

  test('401 without Bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/sync/pull' })
    expect(res.statusCode).toBe(401)
  })
})
