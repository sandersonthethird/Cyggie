import { afterAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

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
    firm_id: null,
    role: 'member',
  })
  return { userId, jwt }
}

function buildMultipart(args: {
  boundary: string
  title?: string
  audioBytes: Buffer
}): { body: Buffer; contentType: string } {
  const { boundary, title, audioBytes } = args
  const parts: Buffer[] = []
  const push = (s: string) => parts.push(Buffer.from(s))

  if (title) {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="title"\r\n\r\n`)
    push(`${title}\r\n`)
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
    createdMeetingIds.push(out.meetingId)

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
    createdMeetingIds.push(out.meetingId)
    const m = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, out.meetingId),
    })
    expect(m?.title).toMatch(/^Meeting /)
  })
})
