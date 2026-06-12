// Integration tests for the recordingStatus augmentation on
// GET /calendar/events. Mocks the Google Calendar API + seeds real
// meetings rows so we can verify:
//   1. Events with a matching meeting come back with the right
//      recordingStatus value.
//   2. Events without a matching meeting have recordingStatus undefined.
//   3. Defensive error handling (per Issue #1 → 1A in the plan review):
//      if the meetings join query throws, the route still returns 200
//      with the calendar events intact — the pill is purely additive
//      and its failure must not break the core feature. Closes the
//      critical-gap regression flagged in review.
//
// Mock strategy: vi.mock('googleapis') returns a stub `google.calendar`
// whose events.list resolves to a controllable list of items. The
// OAuth2 client is also stubbed to a no-op constructor. We seed real
// oauth_tokens + meetings rows in the test DB; teardown removes them.

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

// ─── Google API mock ────────────────────────────────────────────────────────
// Tests adjust `mockedGoogleEvents` to control the list returned by
// calendar.events.list. The auth side (OAuth2 + setCredentials) is a no-op
// — we don't exercise real Google auth here.

interface MockGoogleEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email?: string; displayName?: string }>
}
let mockedGoogleEvents: MockGoogleEvent[] = []

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(_creds: unknown): void {}
        on(_event: string, _cb: unknown): void {}
      },
    },
    calendar: () => ({
      events: {
        list: async () => ({
          data: { items: mockedGoogleEvents },
        }),
      },
    }),
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

const TEST_PREFIX = `test-cal-rec-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

beforeEach(() => {
  mockedGoogleEvents = []
})

async function setupUser(): Promise<{ userId: string; token: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    displayName: userId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  cleanup.track(schema.oauthTokens, schema.oauthTokens.userId, userId)
  await db.insert(schema.oauthTokens).values({
    id: TEST_PREFIX + 'oauth-' + createId().slice(0, 8),
    userId,
    provider: 'google',
    accessToken: 'fake-access-token',
    refreshTokenEncrypted: encryptToken('fake-refresh-token', env.GOOGLE_TOKEN_ENC_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    needsReauth: false,
  })
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

async function insertMeeting(opts: {
  userId: string
  calendarEventId: string
  status: string
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: 'Test meeting for ' + opts.calendarEventId,
    date: new Date(),
    status: opts.status,
    calendarEventId: opts.calendarEventId,
    speakerMap: {},
    attendees: [] as never,
    attendeeEmails: [] as never,
    speakerCount: 0,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function insertCompany(opts: {
  userId: string
  name: string
  primaryDomain: string | null
}): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId: opts.userId,
    canonicalName: opts.name,
    normalizedName: opts.name.toLowerCase(),
    primaryDomain: opts.primaryDomain,
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

async function linkCompanyToMeeting(opts: {
  meetingId: string
  companyId: string
  confidence?: number
}): Promise<void> {
  await db.insert(schema.meetingCompanyLinks).values({
    meetingId: opts.meetingId,
    companyId: opts.companyId,
    confidence: opts.confidence ?? 1.0,
    linkedBy: 'manual',
  })
  cleanup.track(schema.meetingCompanyLinks, schema.meetingCompanyLinks.meetingId, opts.meetingId)
}

describe('GET /calendar/events — recordingStatus augmentation', () => {
  test('augments events with a matching meeting; leaves unmatched events untagged', async () => {
    const { userId, token } = await setupUser()
    const calEventA = `cal-evt-A-${createId().slice(0, 6)}`
    const calEventB = `cal-evt-B-${createId().slice(0, 6)}`
    const calEventC = `cal-evt-C-${createId().slice(0, 6)}`

    // A has a transcribing meeting; B has an error meeting; C has nothing.
    await insertMeeting({ userId, calendarEventId: calEventA, status: 'transcribing' })
    await insertMeeting({ userId, calendarEventId: calEventB, status: 'error' })

    const startISO = new Date(Date.now() + 60_000).toISOString()
    const endISO = new Date(Date.now() + 30 * 60_000).toISOString()
    mockedGoogleEvents = [
      { id: calEventA, summary: 'A', start: { dateTime: startISO }, end: { dateTime: endISO } },
      { id: calEventB, summary: 'B', start: { dateTime: startISO }, end: { dateTime: endISO } },
      { id: calEventC, summary: 'C', start: { dateTime: startISO }, end: { dateTime: endISO } },
    ]

    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: Array<{ calendarEventId: string; recordingStatus?: string }> }
    const byId = new Map(body.events.map((e) => [e.calendarEventId, e]))
    expect(byId.get(calEventA)?.recordingStatus).toBe('transcribing')
    expect(byId.get(calEventB)?.recordingStatus).toBe('error')
    expect(byId.get(calEventC)?.recordingStatus).toBeUndefined()
  })

  test('returns events with no Google items as an empty array (no meetings query needed)', async () => {
    const { token } = await setupUser()
    mockedGoogleEvents = []
    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: unknown[] }
    expect(body.events).toEqual([])
  })

  test('only matches the requesting user\'s own meetings (scoping)', async () => {
    const { userId: userA, token: tokenA } = await setupUser()
    const { userId: userB } = await setupUser()
    const sharedCalEventId = `cal-evt-shared-${createId().slice(0, 6)}`

    // User B has a meeting tied to the calendar event — but the request
    // is made by user A. The meeting must NOT leak across users; user
    // A's response should have recordingStatus undefined for this event.
    await insertMeeting({ userId: userB, calendarEventId: sharedCalEventId, status: 'transcribing' })
    void userA // userId used implicitly via the scoped DB query

    const startISO = new Date(Date.now() + 60_000).toISOString()
    const endISO = new Date(Date.now() + 30 * 60_000).toISOString()
    mockedGoogleEvents = [
      { id: sharedCalEventId, summary: 'shared', start: { dateTime: startISO }, end: { dateTime: endISO } },
    ]

    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: Array<{ calendarEventId: string; recordingStatus?: string }> }
    expect(body.events[0]?.recordingStatus).toBeUndefined()
  })

  test('attaches the highest-confidence linked company to events with a recording', async () => {
    const { userId, token } = await setupUser()
    const calEventA = `cal-evt-co-A-${createId().slice(0, 6)}`
    const calEventB = `cal-evt-co-B-${createId().slice(0, 6)}`
    const calEventC = `cal-evt-co-C-${createId().slice(0, 6)}`

    const meetingA = await insertMeeting({ userId, calendarEventId: calEventA, status: 'transcribed' })
    const meetingB = await insertMeeting({ userId, calendarEventId: calEventB, status: 'transcribed' })
    // calEventC has no meeting → no company expected.

    const acmeId = await insertCompany({ userId, name: 'Acme Corp', primaryDomain: 'acme.com' })
    const ctrlId = await insertCompany({ userId, name: 'Control Co', primaryDomain: null })
    const stripeId = await insertCompany({ userId, name: 'Stripe', primaryDomain: 'stripe.com' })

    // meetingA has Acme as its single linked company.
    await linkCompanyToMeeting({ meetingId: meetingA, companyId: acmeId, confidence: 0.9 })
    // meetingB has two links — Stripe at higher confidence than Control.
    await linkCompanyToMeeting({ meetingId: meetingB, companyId: ctrlId, confidence: 0.4 })
    await linkCompanyToMeeting({ meetingId: meetingB, companyId: stripeId, confidence: 0.95 })

    const startISO = new Date(Date.now() + 60_000).toISOString()
    const endISO = new Date(Date.now() + 30 * 60_000).toISOString()
    mockedGoogleEvents = [
      { id: calEventA, summary: 'A', start: { dateTime: startISO }, end: { dateTime: endISO } },
      { id: calEventB, summary: 'B', start: { dateTime: startISO }, end: { dateTime: endISO } },
      { id: calEventC, summary: 'C', start: { dateTime: startISO }, end: { dateTime: endISO } },
    ]

    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      events: Array<{
        calendarEventId: string
        company?: { id: string; name: string; primaryDomain: string | null }
      }>
    }
    const byId = new Map(body.events.map((e) => [e.calendarEventId, e]))
    expect(byId.get(calEventA)?.company).toEqual({
      id: acmeId,
      name: 'Acme Corp',
      primaryDomain: 'acme.com',
    })
    expect(byId.get(calEventB)?.company).toEqual({
      id: stripeId,
      name: 'Stripe',
      primaryDomain: 'stripe.com',
    })
    expect(byId.get(calEventC)?.company).toBeUndefined()
  })

  test('graceful degradation: meetings-query failure does NOT break the calendar list', async () => {
    // This closes the critical-gap regression flagged in plan review:
    // the recordingStatus augmentation is purely additive UX; a Neon
    // hiccup on the meetings table must not 500 the calendar endpoint.
    //
    // Approach: spy on db.select once it's been imported, force the
    // first call (which is for meetings) to throw. The route's try/catch
    // should swallow it and continue with recordingStatus undefined on
    // every event.
    const { token } = await setupUser()
    const calEvent = `cal-evt-defensive-${createId().slice(0, 6)}`
    const startISO = new Date(Date.now() + 60_000).toISOString()
    const endISO = new Date(Date.now() + 30 * 60_000).toISOString()
    mockedGoogleEvents = [
      { id: calEvent, summary: 'defensive', start: { dateTime: startISO }, end: { dateTime: endISO } },
    ]

    // Monkey-patch db.select so the meetings join blows up. (Other DB
    // operations in the route — oauthTokens.findFirst — use .query.*,
    // not .select(), so we only break the join path.)
    const originalSelect = db.select.bind(db)
    let calls = 0
    type SelectFn = typeof db.select
    ;(db as { select: SelectFn }).select = (...args: Parameters<SelectFn>) => {
      calls += 1
      throw new Error('forced meetings query failure (test)')
    }
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/calendar/events',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { events: Array<{ calendarEventId: string; recordingStatus?: string }> }
      expect(body.events).toHaveLength(1)
      expect(body.events[0]?.recordingStatus).toBeUndefined()
      // Confirm we actually exercised the failing path (not just bypassed it).
      expect(calls).toBeGreaterThan(0)
    } finally {
      ;(db as { select: SelectFn }).select = originalSelect
    }
  })
})
