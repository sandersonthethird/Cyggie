import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// /meetings/:id detail tests against the dev Neon DB.

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

const TEST_PREFIX = `test-mtg-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdCompanyIds: string[] = []
const createdContactIds: string[] = []
const createdMeetingIds: string[] = []

afterAll(async () => {
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdContactIds.length > 0) {
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, createdContactIds))
  }
  if (createdCompanyIds.length > 0) {
    await db
      .delete(schema.orgCompanies)
      .where(inArray(schema.orgCompanies.id, createdCompanyIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
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
  createdUserIds.push(id)
  return id
}

async function insertCompany(userId: string, name: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName: name,
    normalizedName: name.toLowerCase(),
    status: 'active',
  })
  createdCompanyIds.push(id)
  return id
}

async function insertContact(opts: {
  userId: string
  fullName: string
  companyId?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId: opts.userId,
    fullName: opts.fullName,
    normalizedName: opts.fullName.toLowerCase(),
    primaryCompanyId: opts.companyId ?? null,
  })
  createdContactIds.push(id)
  return id
}

async function insertMeeting(opts: {
  userId: string
  title?: string
  date?: Date
  durationSeconds?: number
  transcriptSegments?: unknown
  speakerMap?: Record<string, string>
  notes?: string
  wasImpromptu?: boolean
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: opts.title ?? 'Test Meeting',
    date: opts.date ?? new Date(),
    durationSeconds: opts.durationSeconds ?? 1800,
    status: 'completed',
    transcriptSegments: opts.transcriptSegments ?? null,
    speakerMap: opts.speakerMap ?? {},
    notes: opts.notes ?? null,
    wasImpromptu: opts.wasImpromptu ?? false,
    attendees: ['Alice', 'Bob'] as never,
    attendeeEmails: ['alice@example.com', 'bob@example.com'] as never,
    speakerCount: 2,
  })
  createdMeetingIds.push(id)
  return id
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

describe('GET /meetings/:id', () => {
  test('returns base fields + linked companies + linked contacts + transcript', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId, 'Acme Corp ' + TEST_PREFIX)
    const contactId = await insertContact({
      userId,
      fullName: 'Speaker Priya ' + TEST_PREFIX,
      companyId,
    })

    const meetingId = await insertMeeting({
      userId,
      title: 'Discovery call',
      date: new Date('2026-05-15T10:00:00Z'),
      durationSeconds: 1800,
      notes: 'Discussed roadmap.',
      speakerMap: { '0': 'Sandy', '1': 'Priya' },
      transcriptSegments: [
        {
          speaker: 0,
          text: 'Hi Priya, thanks for hopping on.',
          startTime: 0,
          endTime: 3.2,
          isFinal: true,
          words: [{ word: 'Hi', start: 0, end: 0.5 }], // should get stripped
        },
        {
          speaker: 1,
          text: 'Great to be here.',
          startTime: 3.3,
          endTime: 5.1,
          isFinal: true,
          words: [],
        },
        // Malformed — missing required fields, should be filtered out.
        { speaker: 0, text: 'No times' },
      ],
    })

    // Link company + contact-as-speaker.
    await db.insert(schema.meetingCompanyLinks).values({
      meetingId,
      companyId,
      confidence: 1.0,
      linkedBy: 'manual',
    })
    await db.insert(schema.meetingSpeakerContactLinks).values({
      meetingId,
      speakerIndex: 1,
      contactId,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      title: string
      date: string
      durationSeconds: number
      status: string
      wasImpromptu: boolean
      notes: string | null
      attendees: string[]
      hasTranscript: boolean
      transcriptSegments: Array<{
        speaker: number
        speakerLabel: string | null
        text: string
        startTime: number
        endTime: number
      }>
      linkedCompanies: Array<{ id: string; name: string }>
      linkedContacts: Array<{
        id: string
        fullName: string
        title: string | null
        speakerIndex: number
      }>
    }

    expect(body.id).toBe(meetingId)
    expect(body.title).toBe('Discovery call')
    expect(body.date).toBe('2026-05-15T10:00:00.000Z')
    expect(body.durationSeconds).toBe(1800)
    expect(body.status).toBe('completed')
    expect(body.wasImpromptu).toBe(false)
    expect(body.notes).toBe('Discussed roadmap.')
    expect(body.attendees).toEqual(['Alice', 'Bob'])

    // Transcript: 2 valid segments (malformed one dropped), words/isFinal stripped.
    expect(body.hasTranscript).toBe(true)
    expect(body.transcriptSegments).toHaveLength(2)
    expect(body.transcriptSegments[0]).toEqual({
      speaker: 0,
      speakerLabel: 'Sandy',
      text: 'Hi Priya, thanks for hopping on.',
      startTime: 0,
      endTime: 3.2,
    })
    expect(body.transcriptSegments[1]?.speakerLabel).toBe('Priya')
    expect((body.transcriptSegments[0] as unknown as Record<string, unknown>).words).toBeUndefined()

    // Linked entities.
    expect(body.linkedCompanies).toEqual([{ id: companyId, name: 'Acme Corp ' + TEST_PREFIX }])
    expect(body.linkedContacts).toEqual([
      {
        id: contactId,
        fullName: 'Speaker Priya ' + TEST_PREFIX,
        title: null,
        speakerIndex: 1,
      },
    ])
  })

  test('hasTranscript=false when transcript_segments is null', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({ userId })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      hasTranscript: boolean
      transcriptSegments: unknown[]
    }
    expect(body.hasTranscript).toBe(false)
    expect(body.transcriptSegments).toEqual([])
  })

  test('404 when meeting belongs to a different user', async () => {
    const owner = await insertTestUser()
    const intruder = await insertTestUser()
    const meetingId = await insertMeeting({ userId: owner })

    const jwt = await mintJwt(intruder)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'MEETING_NOT_FOUND' } })
  })

  test('404 for non-existent id', async () => {
    const userId = await insertTestUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/meetings/does-not-exist',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(404)
  })

  test('401 when no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/meetings/whatever' })
    expect(res.statusCode).toBe(401)
  })
})
