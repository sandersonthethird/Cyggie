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

// /recordings/upload now uses requireFirm() and its create-if-absent path
// stamps firm_id onto the meeting row (FK → firms). Each user needs a real
// firm: a null firm_id would 403 NO_FIRM; a dangling one would FK-violate.
async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const firmId = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id: firmId, name: 'Upload Test Firm', slug: firmId })
  cleanup.track(schema.firms, schema.firms.id, firmId)
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

function buildMultipart(args: {
  boundary: string
  title?: string
  calEventId?: string
  meetingId?: string
  audioBytes: Buffer
}): { body: Buffer; contentType: string } {
  const { boundary, title, calEventId, meetingId, audioBytes } = args
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
  if (meetingId) {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="meetingId"\r\n\r\n`)
    push(`${meetingId}\r\n`)
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

    // MEETING_NOT_FOUND regression: firm_id stamped → the row is visible on read.
    expect(meeting?.firmId).toBeTruthy()
    const get = await app.inject({
      method: 'GET',
      url: `/meetings/${out.meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(get.statusCode).toBe(200)
  })

  test('firm-less token → 403 NO_FIRM (no silently-invisible meeting)', async () => {
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
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({ boundary, audioBytes: Buffer.from('audio') })
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
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('NO_FIRM')
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

  // ── client-minted meetingId (impromptu pre-create / offline) ──
  test('create-if-absent: upload with a fresh client meetingId inserts that EXACT id (id stability)', async () => {
    const { userId, jwt } = await setupUser()
    const clientId = createId() // client-minted; no row exists yet (offline pre-create never landed)
    const audioBytes = Buffer.from('audio-offline-impromptu')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({ boundary, meetingId: clientId, audioBytes })

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
    cleanup.track(schema.meetings, schema.meetings.id, out.meetingId)
    // The gateway must NOT re-mint — the id is stable end-to-end.
    expect(out.meetingId).toBe(clientId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, clientId) })
    expect(row?.userId).toBe(userId)
    expect(row?.status).toBe('recording')
    expect(row?.wasImpromptu).toBe(true)
    expect(row?.recordingPath).toBeTruthy()
    expect(submitCalls[0].meetingId).toBe(clientId)
  })

  test('attaches to a caller pre-created row when meetingId matches (no duplicate)', async () => {
    const { userId, jwt } = await setupUser()
    const clientId = createId()
    // Simulate POST /meetings/impromptu having pre-created the row (no audio).
    await db.insert(schema.meetings).values({
      id: clientId,
      userId,
      title: 'Pre-created impromptu',
      date: new Date(),
      status: 'recording',
      wasImpromptu: true,
      notes: 'typed while recording',
      createdByUserId: userId,
    })
    cleanup.track(schema.meetings, schema.meetings.id, clientId)

    const audioBytes = Buffer.from('audio-attach')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({ boundary, meetingId: clientId, audioBytes })
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
    expect(out.meetingId).toBe(clientId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, clientId) })
    expect(row?.recordingPath).toBeTruthy()
    expect(row?.notes).toBe('typed while recording') // pre-recording notes preserved
  })

  test("rejects (409) when meetingId belongs to ANOTHER user — never attaches to a foreign row", async () => {
    const owner = await setupUser()
    const attacker = await setupUser()
    const foreignId = createId()
    await db.insert(schema.meetings).values({
      id: foreignId,
      userId: owner.userId,
      title: "Owner's meeting",
      date: new Date(),
      status: 'recording',
      wasImpromptu: true,
      createdByUserId: owner.userId,
    })
    cleanup.track(schema.meetings, schema.meetings.id, foreignId)

    const audioBytes = Buffer.from('audio-attacker')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({ boundary, meetingId: foreignId, audioBytes })
    const res = await app.inject({
      method: 'POST',
      url: '/recordings/upload',
      headers: {
        authorization: `Bearer ${attacker.jwt}`,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(409)
    // The owner's row is untouched (no recordingPath attached).
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, foreignId) })
    expect(row?.userId).toBe(owner.userId)
    expect(row?.recordingPath).toBeNull()
  })

  test('rejects malformed meetingId (400)', async () => {
    const { jwt } = await setupUser()
    const audioBytes = Buffer.from('audio')
    const boundary = '----TestBoundary' + Date.now().toString(36)
    const { body, contentType } = buildMultipart({
      boundary,
      meetingId: 'NOT valid id!!',
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
    expect(res.statusCode).toBe(400)
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
