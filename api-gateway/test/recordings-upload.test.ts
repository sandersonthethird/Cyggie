import { afterAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// POST /recordings/upload happy path:
//   • multipart audio + title  →  202 { meetingId }
//   • meetings row inserted (status='recording', wasImpromptu=true, recordingPath set)
//   • submitTranscribeJob fires (mocked — we don't hit Deepgram in tests)

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
process.env['DEEPGRAM_WEBHOOK_SECRET'] = 'test-webhook-secret-at-least-16-chars'
if (!process.env['DEEPGRAM_API_KEY']) process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key'

// Capture-mode submitTranscribeJob — records the call but doesn't hit Deepgram.
const submitCalls: Array<{ meetingId: string; audioFilePath: string }> = []
vi.mock('../src/recording/transcribe-job', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    submitTranscribeJob: async (args: { meetingId: string; audioFilePath: string }) => {
      submitCalls.push({ meetingId: args.meetingId, audioFilePath: args.audioFilePath })
      return { requestId: 'fake-dg-request-id' }
    },
  }
})

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-upload-${Date.now().toString(36)}-`
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

function buildMultipart(args: {
  boundary: string
  title?: string
  calEventId?: string
  audioBytes: Buffer
}): { body: Buffer; contentType: string } {
  const { boundary, title, calEventId, audioBytes } = args
  const parts: Buffer[] = []
  const push = (s: string) => parts.push(Buffer.from(s))

  if (title) {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="title"\r\n\r\n`)
    push(`${title}\r\n`)
  }
  if (calEventId) {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="calEventId"\r\n\r\n`)
    push(`${calEventId}\r\n`)
  }

  push(`--${boundary}\r\n`)
  push(`Content-Disposition: form-data; name="audio"; filename="test.aac"\r\n`)
  push(`Content-Type: audio/aac\r\n\r\n`)
  parts.push(audioBytes)
  push(`\r\n--${boundary}--\r\n`)

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('POST /recordings/upload', () => {
  test('happy path: 202 + meeting inserted + transcribe job fired', async () => {
    const { userId, jwt } = await setupUser()
    const audioBytes = Buffer.from('fake-aac-audio-bytes-here-this-is-not-real-audio')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({
      boundary,
      title: 'My Upload Test Meeting',
      audioBytes,
    })

    submitCalls.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    const out = res.json() as { meetingId: string }
    expect(out.meetingId).toBeTruthy()
    cleanup.track(schema.meetings, schema.meetings.id, out.meetingId)

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, out.meetingId),
    })
    expect(meeting).toBeDefined()
    expect(meeting?.userId).toBe(userId)
    expect(meeting?.title).toBe('My Upload Test Meeting')
    expect(meeting?.status).toBe('recording')
    expect(meeting?.wasImpromptu).toBe(true)
    expect(meeting?.recordingPath).toBeTruthy()

    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0].meetingId).toBe(out.meetingId)
    expect(submitCalls[0].audioFilePath).toBe(meeting?.recordingPath)
  })

  test('rejects request without a JWT (401)', async () => {
    const audioBytes = Buffer.from('audio')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({ boundary, audioBytes })
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: { 'content-type': contentType, 'content-length': String(body.length) },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })

  test('reuses existing scheduled row when calEventId matches a prior /from-calendar-event tap', async () => {
    const { userId, jwt } = await setupUser()
    const calEventId = 'gcal-reuse-' + createId()

    // Pre-create a scheduled row as if mobile had tapped /from-calendar-event
    // first (the new mobile UX). Pre-populate notes that the user might have
    // typed ahead of the meeting.
    const preExistingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
    await db.insert(schema.meetings).values({
      id: preExistingId,
      userId,
      title: 'Pre-existing',
      date: new Date('2026-05-21T15:00:00Z'),
      status: 'scheduled',
      calendarEventId: calEventId,
      notes: 'notes typed before recording started',
      lamport: '3',
      wasImpromptu: false,
      createdByUserId: userId,
    })
    cleanup.track(schema.meetings, schema.meetings.id, preExistingId)

    const audioBytes = Buffer.from('audio-after-tap')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({
      boundary,
      calEventId,
      audioBytes,
    })

    submitCalls.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    const out = res.json() as { meetingId: string }
    // SAME id as the pre-existing row — no duplicate created.
    expect(out.meetingId).toBe(preExistingId)

    const row = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, preExistingId),
    })
    expect(row?.status).toBe('recording')
    expect(row?.recordingPath).toBeTruthy()
    // Pre-existing notes preserved
    expect(row?.notes).toBe('notes typed before recording started')
    // Title preserved (we don't clobber user-set values)
    expect(row?.title).toBe('Pre-existing')
    // Was not impromptu — calendar-event-anchored
    expect(row?.wasImpromptu).toBe(false)

    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0].meetingId).toBe(preExistingId)
  })

  test('inserts new row when calEventId has no prior meeting', async () => {
    const { userId, jwt } = await setupUser()
    const calEventId = 'gcal-fresh-' + createId()
    const audioBytes = Buffer.from('audio-fresh')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({
      boundary,
      calEventId,
      audioBytes,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    const out = res.json() as { meetingId: string }
    cleanup.track(schema.meetings, schema.meetings.id, out.meetingId)

    const row = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, out.meetingId),
    })
    expect(row?.userId).toBe(userId)
    expect(row?.calendarEventId).toBe(calEventId)
    expect(row?.status).toBe('recording')
    expect(row?.wasImpromptu).toBe(true) // FAB-style: no prior row → impromptu
  })

  test('default title when none provided', async () => {
    const { jwt } = await setupUser()
    const audioBytes = Buffer.from('audio')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({ boundary, audioBytes })
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    const out = res.json() as { meetingId: string }
    cleanup.track(schema.meetings, schema.meetings.id, out.meetingId)
    const m = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, out.meetingId),
    })
    expect(m?.title).toMatch(/^Meeting /)
  })
})
