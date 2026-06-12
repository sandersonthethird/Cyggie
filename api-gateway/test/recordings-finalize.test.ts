import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Three paths for the Deepgram batch webhook + APNs finalize step:
//   1. Valid secret → meeting flips to 'transcribed', segments persisted,
//      APNs send fired with the correct payload.
//   2. Invalid / missing secret → 401, no DB write, no push.
//   3. APNs returns 410 Unregistered → that session's apns_device_token is
//      NULL-ed so subsequent pushes for that session no-op.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
process.env['DEEPGRAM_WEBHOOK_SECRET'] = 'test-webhook-secret-at-least-16-chars'
if (!process.env['DEEPGRAM_API_KEY']) process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key'

// Capture-mode APNs provider: every sendTranscriptionReady / Empty call is
// recorded into `apnsCalls` with a `kind` discriminator so path-5 can assert
// which APNs method fired. The 410 path is driven via `setApnsResultForNextCall`.
type ApnsResult = { ok: boolean; unregistered: string[] }
const apnsCalls: Array<{ kind: 'ready' | 'empty'; deviceToken: string; meetingId: string; title: string }> = []
let nextApnsResult: ApnsResult = { ok: true, unregistered: [] }
function setApnsResultForNextCall(r: ApnsResult): void {
  nextApnsResult = r
}

vi.mock('../src/push/apns', () => ({
  initApnsClient: () => ({
    sendTranscriptionReady: async (args: {
      deviceToken: string
      meetingId: string
      title: string
    }) => {
      apnsCalls.push({ kind: 'ready', ...args })
      const r = nextApnsResult
      nextApnsResult = { ok: true, unregistered: [] }
      return r
    },
    sendTranscriptionFailed: async () => ({ ok: true, unregistered: [] }),
    sendTranscriptionEmpty: async (args: {
      deviceToken: string
      meetingId: string
      title: string
    }) => {
      apnsCalls.push({ kind: 'empty', ...args })
      const r = nextApnsResult
      nextApnsResult = { ok: true, unregistered: [] }
      return r
    },
  }),
}))

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-finalize-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

beforeEach(() => {
  apnsCalls.length = 0
})
afterEach(() => {
  nextApnsResult = { ok: true, unregistered: [] }
})

async function setupUserSessionMeeting(args: {
  apnsDeviceToken?: string | null
}): Promise<{ userId: string; sessionId: string; meetingId: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const sessionId = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  await db.insert(schema.sessions).values({
    id: sessionId,
    userId,
    deviceId: 'test-device-' + sessionId,
    refreshTokenHash: 'hash-' + sessionId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    apnsDeviceToken: args.apnsDeviceToken ?? null,
    apnsEnvironment: args.apnsDeviceToken ? 'sandbox' : null,
    apnsTokenUpdatedAt: args.apnsDeviceToken ? new Date() : null,
  })
  cleanup.track(schema.sessions, schema.sessions.id, sessionId)
  await db.insert(schema.meetings).values({
    id: meetingId,
    userId,
    title: 'Webhook Test Meeting',
    date: new Date(),
    status: 'recording',
    deepgramRequestId: 'dg-req-' + meetingId,
  })
  cleanup.track(schema.meetings, schema.meetings.id, meetingId)
  return { userId, sessionId, meetingId }
}

function fakeDeepgramPayload(): unknown {
  return {
    metadata: { duration: 92.5, channels: 1, request_id: 'dg-req-1' },
    results: {
      channels: [{ alternatives: [{ transcript: 'Hello world.', words: [] }] }],
      utterances: [
        {
          start: 0,
          end: 2.1,
          confidence: 0.97,
          channel: 0,
          transcript: 'Hello world.',
          words: [],
          speaker: 0,
        },
        {
          start: 2.1,
          end: 4.2,
          confidence: 0.95,
          channel: 0,
          transcript: 'Goodbye.',
          words: [],
          speaker: 1,
        },
      ],
    },
  }
}

describe('POST /recordings/deepgram-webhook', () => {
  test('path 1: valid secret persists transcript + fires APNs', async () => {
    const { sessionId, meetingId } = await setupUserSessionMeeting({
      apnsDeviceToken: 'dev-token-aaa',
    })
    const res = await app.inject({
      method: 'POST',
      url: `/recordings/deepgram-webhook?meetingId=${meetingId}&secret=${env.DEEPGRAM_WEBHOOK_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: fakeDeepgramPayload(),
    })
    expect(res.statusCode).toBe(200)

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    expect(meeting?.status).toBe('transcribed')
    expect(meeting?.durationSeconds).toBe(92)
    expect(meeting?.speakerCount).toBe(2)
    expect(meeting?.speakerMap).toEqual({ 0: 'Speaker 1', 1: 'Speaker 2' })
    expect(Array.isArray(meeting?.transcriptSegments)).toBe(true)
    expect((meeting?.transcriptSegments as unknown[]).length).toBe(2)
    // Regression: stored shape must match what the read path
    // (normalizeSegments in routes/meetings.ts) expects — speaker/text/
    // startTime/endTime, NOT Deepgram's raw speaker/transcript/start/end.
    // Without this assertion the webhook silently stored Deepgram's raw
    // shape and the detail screen rendered "No transcript" despite
    // status='transcribed'. Caught in cathedral-build E2E on 2026-05-21.
    const segs = meeting?.transcriptSegments as Array<Record<string, unknown>>
    expect(segs[0]).toMatchObject({
      speaker: expect.any(Number),
      text: expect.any(String),
      startTime: expect.any(Number),
      endTime: expect.any(Number),
    })

    expect(apnsCalls).toHaveLength(1)
    expect(apnsCalls[0]).toEqual({
      kind: 'ready',
      deviceToken: 'dev-token-aaa',
      meetingId,
      title: 'Webhook Test Meeting',
    })

    // Session token still present (no 410 in this path).
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    })
    expect(session?.apnsDeviceToken).toBe('dev-token-aaa')
  })

  test('path 2: invalid secret → 401, no DB write, no push', async () => {
    const { meetingId } = await setupUserSessionMeeting({ apnsDeviceToken: 'dev-token-bbb' })
    const res = await app.inject({
      method: 'POST',
      url: `/recordings/deepgram-webhook?meetingId=${meetingId}&secret=wrong-secret-here`,
      headers: { 'content-type': 'application/json' },
      payload: fakeDeepgramPayload(),
    })
    expect(res.statusCode).toBe(401)

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    expect(meeting?.status).toBe('recording') // unchanged
    expect(apnsCalls).toHaveLength(0)
  })

  test('path 4: Deepgram error-payload (no `results`) → meeting=error, no push, 200', async () => {
    const { meetingId } = await setupUserSessionMeeting({ apnsDeviceToken: 'dev-token-ddd' })
    const res = await app.inject({
      method: 'POST',
      url: `/recordings/deepgram-webhook?meetingId=${meetingId}&secret=${env.DEEPGRAM_WEBHOOK_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: {
        type: 'JobFailedNotification',
        request_id: 'dg-req-fail-1',
        err_code: 'GENERAL_BAD_REQUEST',
        err_msg: 'corrupt or unsupported data',
      },
    })
    expect(res.statusCode).toBe(200)

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    expect(meeting?.status).toBe('error')
    expect(apnsCalls).toHaveLength(0)
  })

  test('path 5: Deepgram returns 2xx with empty utterances → status=empty + APNs empty', async () => {
    const { meetingId } = await setupUserSessionMeeting({
      apnsDeviceToken: 'dev-token-empty-1',
    })
    const emptyPayload = {
      metadata: { duration: 12.4, channels: 1, request_id: 'dg-req-empty-1' },
      results: {
        channels: [{ alternatives: [{ transcript: '', words: [] }] }],
        utterances: [],
      },
    }
    const res = await app.inject({
      method: 'POST',
      url: `/recordings/deepgram-webhook?meetingId=${meetingId}&secret=${env.DEEPGRAM_WEBHOOK_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: emptyPayload,
    })
    expect(res.statusCode).toBe(200)

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    expect(meeting?.status).toBe('empty')
    expect(meeting?.durationSeconds).toBe(12)
    expect(meeting?.speakerCount).toBe(0)
    expect(meeting?.transcriptSegments).toEqual([])

    expect(apnsCalls).toHaveLength(1)
    expect(apnsCalls[0]).toEqual({
      kind: 'empty',
      deviceToken: 'dev-token-empty-1',
      meetingId,
      title: 'Webhook Test Meeting',
    })
  })

  test('path 3: APNs 410 Unregistered → session token cleaned up', async () => {
    const { sessionId, meetingId } = await setupUserSessionMeeting({
      apnsDeviceToken: 'dev-token-ccc',
    })
    setApnsResultForNextCall({ ok: false, unregistered: ['dev-token-ccc'] })

    const res = await app.inject({
      method: 'POST',
      url: `/recordings/deepgram-webhook?meetingId=${meetingId}&secret=${env.DEEPGRAM_WEBHOOK_SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: fakeDeepgramPayload(),
    })
    expect(res.statusCode).toBe(200)

    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, sessionId),
    })
    expect(session?.apnsDeviceToken).toBeNull()
    expect(session?.apnsEnvironment).toBeNull()
  })
})
