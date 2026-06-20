import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// GET /meetings/impromptu — T16. Returns recent impromptu (no-cal-event)
// meetings for the calling user. Mobile calendar tab renders these in a
// "My Recordings" section so impromptu rows can be found after closing
// the app post-recording.
//
// Coverage:
//   • returns only calendar_event_id IS NULL rows
//   • respects the `days` window (older rows excluded)
//   • cross-user isolation
//   • LIMIT 20 enforced
//   • days outside [1, 30] → 400 (Zod validation)

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

const TEST_PREFIX = `test-impromptu-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

// WS1 — GET /meetings/impromptu is now firm-scoped (entityVisibilityFilter:
// firm_id = me.firm AND (own OR not private)). Because impromptu rows are
// firm-visible, a single shared firm would leak rows ACROSS tests. Give each
// test its OWN firm (beforeEach) so firm-scoped reads stay isolated; all users
// in a test share that firm so same-firm-sharing assertions work. Mirrors
// sync-pull.test.ts.
let CURRENT_FIRM_ID = TEST_PREFIX + 'firm'

async function insertFirm(): Promise<string> {
  const id = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id, name: 'Impromptu Test Firm', slug: id })
  cleanup.track(schema.firms, schema.firms.id, id)
  return id
}

beforeEach(async () => {
  CURRENT_FIRM_ID = await insertFirm()
})

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function setupUser(firmId: string = CURRENT_FIRM_ID): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    firmId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
  return { userId, jwt }
}

async function insertMeeting(args: {
  userId: string
  calendarEventId: string | null
  title: string
  date: Date
  status?: string
  firmId?: string
  isPrivate?: boolean
}): Promise<string> {
  const id = createId()
  await db.insert(schema.meetings).values({
    id,
    userId: args.userId,
    calendarEventId: args.calendarEventId,
    title: args.title,
    date: args.date,
    status: args.status ?? 'transcribed',
    createdByUserId: args.userId,
    firmId: args.firmId ?? CURRENT_FIRM_ID,
    isPrivate: args.isPrivate ?? false,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

describe('GET /meetings/impromptu', () => {
  test('returns only calendar_event_id IS NULL rows', async () => {
    const { userId, jwt } = await setupUser()
    const now = new Date()
    // 1 impromptu + 1 calendar-anchored. Both within window.
    const impromptuId = await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'Impromptu chat',
      date: new Date(now.getTime() - 60 * 60 * 1000), // 1h ago
    })
    await insertMeeting({
      userId,
      calendarEventId: 'gcal-' + createId(),
      title: 'Scheduled standup',
      date: new Date(now.getTime() - 30 * 60 * 1000), // 30min ago
    })

    const res = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { meetings: Array<{ id: string; title: string }> }
    expect(body.meetings).toHaveLength(1)
    expect(body.meetings[0]?.id).toBe(impromptuId)
    expect(body.meetings[0]?.title).toBe('Impromptu chat')
  })

  test('respects the days window — rows outside excluded', async () => {
    const { userId, jwt } = await setupUser()
    const now = new Date()
    // Inside default 7d window
    const recentId = await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'Yesterday recording',
      date: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    })
    // 14 days ago — outside default 7d window
    await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'Old recording',
      date: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu', // default days=7
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { meetings: Array<{ id: string }> }
    expect(body.meetings).toHaveLength(1)
    expect(body.meetings[0]?.id).toBe(recentId)

    // Bumping days=30 should bring the older one back too.
    const res30 = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu?days=30',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body30 = res30.json() as { meetings: Array<{ id: string }> }
    expect(body30.meetings).toHaveLength(2)
  })

  test('cross-FIRM isolation — user A does not see another firm impromptu', async () => {
    // WS1 widened the impromptu list from user to firm scope, so the isolation
    // boundary is now the firm. A recording owned by a DIFFERENT firm's user
    // must stay invisible.
    const otherFirm = await insertFirm()
    const a = await setupUser()
    const b = await setupUser(otherFirm)
    const now = new Date()

    await insertMeeting({
      userId: a.userId,
      calendarEventId: null,
      title: 'A recording',
      date: new Date(now.getTime() - 60 * 60 * 1000),
    })
    await insertMeeting({
      userId: b.userId,
      calendarEventId: null,
      title: 'B recording',
      date: new Date(now.getTime() - 30 * 60 * 1000),
      firmId: otherFirm,
    })

    const resA = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu',
      headers: { authorization: `Bearer ${a.jwt}` },
    })
    const bodyA = resA.json() as { meetings: Array<{ title: string }> }
    expect(bodyA.meetings.map((m) => m.title)).toEqual(['A recording'])

    const resB = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu',
      headers: { authorization: `Bearer ${b.jwt}` },
    })
    const bodyB = resB.json() as { meetings: Array<{ title: string }> }
    expect(bodyB.meetings.map((m) => m.title)).toEqual(['B recording'])
  })

  test('firm-shared — caller sees a teammate non-private impromptu but NOT a private one', async () => {
    const me = await setupUser()
    const teammate = await setupUser() // same CURRENT_FIRM_ID
    const now = new Date()

    await insertMeeting({
      userId: teammate.userId,
      calendarEventId: null,
      title: 'Teammate shared recording',
      date: new Date(now.getTime() - 60 * 60 * 1000),
    })
    await insertMeeting({
      userId: teammate.userId,
      calendarEventId: null,
      title: 'Teammate private recording',
      date: new Date(now.getTime() - 30 * 60 * 1000),
      isPrivate: true,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu',
      headers: { authorization: `Bearer ${me.jwt}` },
    })
    const titles = (res.json() as { meetings: Array<{ title: string }> }).meetings.map(
      (m) => m.title,
    )
    expect(titles).toContain('Teammate shared recording')
    expect(titles).not.toContain('Teammate private recording')
  })

  test('LIMIT 20 enforced — insert 25, get 20 most recent', async () => {
    const { userId, jwt } = await setupUser()
    const now = new Date()
    // Insert 25 impromptu rows spaced 1 hour apart, newest first.
    for (let i = 0; i < 25; i++) {
      await insertMeeting({
        userId,
        calendarEventId: null,
        title: `Recording ${i}`,
        date: new Date(now.getTime() - (i + 1) * 60 * 60 * 1000),
      })
    }

    const res = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu?days=30',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { meetings: Array<{ title: string }> }
    expect(body.meetings).toHaveLength(20)
    // Ordered by date DESC, so we should see Recording 0..19 (newest 20).
    expect(body.meetings[0]?.title).toBe('Recording 0')
    expect(body.meetings[19]?.title).toBe('Recording 19')
  })

  test("excludes status='error' and status='empty' rows — failed recordings don't clutter My Recordings", async () => {
    const { userId, jwt } = await setupUser()
    const now = new Date()
    // Mix of statuses, all impromptu, all in window.
    const transcribedId = await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'Successful recording',
      date: new Date(now.getTime() - 60 * 60 * 1000),
      status: 'transcribed',
    })
    await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'Failed recording',
      date: new Date(now.getTime() - 30 * 60 * 1000),
      status: 'error',
    })
    await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'Silent recording',
      date: new Date(now.getTime() - 15 * 60 * 1000),
      status: 'empty',
    })
    const transcribingId = await insertMeeting({
      userId,
      calendarEventId: null,
      title: 'In-flight recording',
      date: new Date(now.getTime() - 5 * 60 * 1000),
      status: 'transcribing',
    })

    const res = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { meetings: Array<{ id: string; status: string }> }
    const ids = body.meetings.map((m) => m.id).sort()
    expect(ids).toEqual([transcribedId, transcribingId].sort())
  })

  test('days outside [1, 30] → 400', async () => {
    const { jwt } = await setupUser()

    const tooHigh = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu?days=31',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(tooHigh.statusCode).toBe(400)

    const tooLow = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu?days=0',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(tooLow.statusCode).toBe(400)

    const notANumber = await app.inject({
      method: 'GET',
      url: '/meetings/impromptu?days=banana',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(notANumber.statusCode).toBe(400)
  })
})
