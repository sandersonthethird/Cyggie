import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Eng-review Issue 6A — lightweight tests for POST /meetings/:id/enhance.
// Covers the non-Anthropic codepaths:
//   • Issue 1A transcript-shape gate (null / empty / all-empty segments)
//   • Ownership filter (another user's meeting → 404 not 403, no leak)
//   • Template-id enum gate (zod blocks unknown)
// Anthropic-mocked happy-path test is deferred per T23 (same posture as
// the existing chat routes).

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

const TEST_PREFIX = `test-enh-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function insertTestUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName: id,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

async function insertMeeting(opts: {
  userId: string
  transcriptSegments?: unknown
  speakerMap?: Record<string, string>
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: 'Enhance test meeting',
    date: new Date('2026-05-15T10:00:00Z'),
    durationSeconds: 1800,
    status: 'transcribed',
    transcriptSegments: opts.transcriptSegments ?? null,
    speakerMap: opts.speakerMap ?? { '0': 'Sandy' },
    speakerCount: 1,
    wasImpromptu: false,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: TEST_PREFIX + 'dev',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

describe('POST /meetings/:id/enhance — transcript-shape gate (Issue 1A)', () => {
  test('rejects with 400 NO_TRANSCRIPT when transcriptSegments is null', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({ userId, transcriptSegments: null })
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { templateId: 'general' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'NO_TRANSCRIPT' } })
  })

  test('rejects with 400 NO_TRANSCRIPT when transcriptSegments is empty array', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({ userId, transcriptSegments: [] })
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { templateId: 'general' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'NO_TRANSCRIPT' } })
  })

  test('rejects with 400 NO_TRANSCRIPT when all segments have empty text', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({
      userId,
      transcriptSegments: [
        { speaker: 0, text: '', startTime: 0, endTime: 1 },
        { speaker: 0, text: '   ', startTime: 1, endTime: 2 },
      ],
    })
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { templateId: 'general' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'NO_TRANSCRIPT' } })
  })
})

describe('POST /meetings/:id/enhance — ownership filter', () => {
  test('rejects with 404 (not 403) when caller does not own the meeting', async () => {
    const ownerId = await insertTestUser()
    const otherUserId = await insertTestUser()
    const meetingId = await insertMeeting({
      userId: ownerId,
      transcriptSegments: [
        { speaker: 0, text: 'Real content here', startTime: 0, endTime: 5 },
      ],
    })
    const otherJwt = await mintJwt(otherUserId)

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      headers: { authorization: `Bearer ${otherJwt}` },
      payload: { templateId: 'general' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'MEETING_NOT_FOUND' } })
  })
})

describe('POST /meetings/:id/enhance — template id gate', () => {
  test('rejects with 400 when templateId is unknown (zod enum)', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({
      userId,
      transcriptSegments: [
        { speaker: 0, text: 'Real content here', startTime: 0, endTime: 5 },
      ],
    })
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { templateId: 'made_up_template' },
    })

    // Zod rejects with 400 BAD_REQUEST before the handler runs.
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  test('rejects with 400 when templateId is missing entirely', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({
      userId,
      transcriptSegments: [
        { speaker: 0, text: 'Real content here', startTime: 0, endTime: 5 },
      ],
    })
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})

describe('POST /meetings/:id/enhance — auth gate', () => {
  test('rejects with 401 when no JWT', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({
      userId,
      transcriptSegments: [
        { speaker: 0, text: 'Real content here', startTime: 0, endTime: 5 },
      ],
    })

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/enhance`,
      payload: { templateId: 'general' },
    })

    expect(res.statusCode).toBe(401)
  })
})
