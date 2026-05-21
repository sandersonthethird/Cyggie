import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// POST /meetings/from-calendar-event — idempotent find-or-create that the
// mobile calendar-tap flow calls before navigating to /meetings/<id>.
//
// Coverage:
//   • happy path — first tap creates the row, returns 201
//   • idempotent — second tap returns the same id with 200
//   • per-user isolation — same calEventId can exist for two users
//   • unauthenticated → 401
//   • cross-user attempt does NOT return the other user's row (it creates
//     a separate one scoped to the caller)

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

const TEST_PREFIX = `test-fce-${Date.now().toString(36)}-`
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

async function reapMeeting(id: string): Promise<void> {
  createdMeetingIds.push(id)
}

describe('POST /meetings/from-calendar-event', () => {
  test('first tap creates a scheduled meeting (201)', async () => {
    const { userId, jwt } = await setupUser()
    const calEventId = 'gcal-' + createId()
    const startTime = '2026-05-21T15:00:00.000Z'

    const res = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        calendarEventId: calEventId,
        title: 'Discovery call',
        startTime,
        attendees: ['Alice', 'Bob'],
        attendeeEmails: ['alice@example.com', 'bob@example.com'],
        meetingPlatform: 'google_meet',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as {
      id: string
      title: string
      status: string
      date: string
      wasImpromptu: boolean
      lamport: string
      attendees: string[] | null
      meetingPlatform: string | null
      meetingUrl: string | null
    }
    await reapMeeting(body.id)
    expect(body.title).toBe('Discovery call')
    expect(body.status).toBe('scheduled')
    expect(body.date).toBe(startTime)
    expect(body.wasImpromptu).toBe(false)
    expect(body.meetingPlatform).toBe('google_meet')
    expect(body.meetingUrl).toBe('https://meet.google.com/abc-defg-hij')
    expect(body.attendees).toEqual(['Alice', 'Bob'])
    expect(typeof body.lamport).toBe('string')

    // Verify DB state
    const row = await db.query.meetings.findFirst({
      where: and(
        eq(schema.meetings.userId, userId),
        eq(schema.meetings.calendarEventId, calEventId),
      ),
    })
    expect(row?.id).toBe(body.id)
    expect(row?.status).toBe('scheduled')
    expect(row?.createdByUserId).toBe(userId)
  })

  test('second tap is idempotent — returns same id, 200', async () => {
    const { userId, jwt } = await setupUser()
    const calEventId = 'gcal-' + createId()

    const payload = {
      calendarEventId: calEventId,
      title: 'Standup',
      startTime: '2026-05-21T16:00:00.000Z',
    }

    const first = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload,
    })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json() as { id: string }
    await reapMeeting(firstBody.id)

    const second = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload,
    })
    expect(second.statusCode).toBe(200)
    const secondBody = second.json() as { id: string }
    expect(secondBody.id).toBe(firstBody.id)

    // Should still be exactly one row in DB
    const rows = await db.query.meetings.findMany({
      where: and(
        eq(schema.meetings.userId, userId),
        eq(schema.meetings.calendarEventId, calEventId),
      ),
    })
    expect(rows).toHaveLength(1)
  })

  test('per-user isolation — same calEventId can exist for two users', async () => {
    const alice = await setupUser()
    const bob = await setupUser()
    const sharedCalEventId = 'gcal-shared-' + createId()

    const aliceRes = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { authorization: `Bearer ${alice.jwt}`, 'content-type': 'application/json' },
      payload: {
        calendarEventId: sharedCalEventId,
        title: 'Shared',
        startTime: '2026-05-22T10:00:00.000Z',
      },
    })
    expect(aliceRes.statusCode).toBe(201)
    const aliceBody = aliceRes.json() as { id: string }
    await reapMeeting(aliceBody.id)

    const bobRes = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { authorization: `Bearer ${bob.jwt}`, 'content-type': 'application/json' },
      payload: {
        calendarEventId: sharedCalEventId,
        title: 'Shared',
        startTime: '2026-05-22T10:00:00.000Z',
      },
    })
    // Migration 0014: per-user partial unique on (user_id, calendar_event_id)
    // — Bob's insert must succeed and produce a different row.
    expect(bobRes.statusCode).toBe(201)
    const bobBody = bobRes.json() as { id: string }
    await reapMeeting(bobBody.id)

    expect(bobBody.id).not.toBe(aliceBody.id)
  })

  test('401 without Bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { 'content-type': 'application/json' },
      payload: {
        calendarEventId: 'gcal-' + createId(),
        title: 'Anon',
        startTime: '2026-05-21T18:00:00.000Z',
      },
    })
    expect(res.statusCode).toBe(401)
  })

  test('rejects body missing required fields with 400', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'POST',
      url: '/meetings/from-calendar-event',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { title: 'No calEventId or startTime' },
    })
    expect(res.statusCode).toBe(400)
  })
})
