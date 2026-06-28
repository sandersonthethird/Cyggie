import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// T40 — GET /meetings/:id/transcript. On-demand transcript fetch used by the
// desktop/mobile cache-fill once /sync/pull stops shipping transcript_segments.
//
// Coverage:
//   • returns normalized segments (speakerLabel resolved, words stripped)
//   • returns [] when the meeting has no transcript
//   • 404 when the meeting is in another firm (IDOR guard)
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

const TEST_PREFIX = `test-mtt-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

let CURRENT_FIRM_ID = TEST_PREFIX + 'firm'

async function insertFirm(): Promise<string> {
  const id = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id, name: 'Transcript Test Firm', slug: id })
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

async function insertUser(firmId: string = CURRENT_FIRM_ID): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    firmId,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

async function insertMeeting(opts: {
  userId: string
  transcriptSegments?: unknown
  speakerMap?: Record<string, string>
  firmId?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: 'Transcript Meeting',
    date: new Date('2026-05-20T10:00:00Z'),
    status: 'transcribed',
    transcriptSegments: opts.transcriptSegments ?? null,
    speakerMap: opts.speakerMap ?? {},
    firmId: opts.firmId ?? CURRENT_FIRM_ID,
    createdByUserId: opts.userId,
    lamport: '1',
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function mintJwt(userId: string, firmId: string = CURRENT_FIRM_ID): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
}

describe('GET /meetings/:id/transcript', () => {
  test('returns normalized segments with speakerLabel + words stripped', async () => {
    const userId = await insertUser()
    const id = await insertMeeting({
      userId,
      speakerMap: { '0': 'Sandy', '1': 'Priya' },
      transcriptSegments: [
        {
          speaker: 0,
          text: 'hello',
          startTime: 0,
          endTime: 1.5,
          isFinal: true,
          words: [{ word: 'hello', start: 0, end: 1.5 }],
        },
        { speaker: 1, text: 'hi', startTime: 1.5, endTime: 3, isFinal: true },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${id}/transcript`,
      headers: { authorization: `Bearer ${await mintJwt(userId)}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      transcriptSegments: Array<Record<string, unknown>>
    }
    expect(body.transcriptSegments).toHaveLength(2)
    expect(body.transcriptSegments[0]).toEqual({
      speaker: 0,
      speakerLabel: 'Sandy',
      text: 'hello',
      startTime: 0,
      endTime: 1.5,
    })
    expect(body.transcriptSegments[1]?.speakerLabel).toBe('Priya')
    // words[] must not travel on-demand either.
    expect(body.transcriptSegments[0]?.words).toBeUndefined()
  })

  test('returns [] when the meeting has no transcript', async () => {
    const userId = await insertUser()
    const id = await insertMeeting({ userId, transcriptSegments: null })

    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${id}/transcript`,
      headers: { authorization: `Bearer ${await mintJwt(userId)}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { transcriptSegments: unknown[] }
    expect(body.transcriptSegments).toEqual([])
  })

  test('404 for a meeting in another firm (IDOR guard)', async () => {
    // Meeting owned by a user in a DIFFERENT firm.
    const otherFirm = await insertFirm()
    const otherUser = await insertUser(otherFirm)
    const foreignMeeting = await insertMeeting({
      userId: otherUser,
      firmId: otherFirm,
      transcriptSegments: [{ speaker: 0, text: 'secret', startTime: 0, endTime: 1, isFinal: true }],
    })

    const caller = await insertUser() // back in CURRENT_FIRM_ID
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${foreignMeeting}/transcript`,
      headers: { authorization: `Bearer ${await mintJwt(caller)}` },
    })
    expect(res.statusCode).toBe(404)
  })

  test('401 when unauthenticated', async () => {
    const userId = await insertUser()
    const id = await insertMeeting({ userId })
    const res = await app.inject({ method: 'GET', url: `/meetings/${id}/transcript` })
    expect(res.statusCode).toBe(401)
  })
})
