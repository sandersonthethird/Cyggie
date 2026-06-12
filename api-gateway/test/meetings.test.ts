import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

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

async function insertCompany(userId: string, name: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName: name,
    normalizedName: name.toLowerCase(),
    status: 'active',
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

async function insertContact(opts: {
  userId: string
  fullName: string
  companyId?: string
  email?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId: opts.userId,
    fullName: opts.fullName,
    normalizedName: opts.fullName.toLowerCase(),
    primaryCompanyId: opts.companyId ?? null,
    email: opts.email ?? null,
  })
  cleanup.track(schema.contacts, schema.contacts.id, id)
  return id
}

async function insertContactEmailAlias(contactId: string, email: string): Promise<void> {
  await db.insert(schema.contactEmails).values({
    contactId,
    email,
    isPrimary: 0,
  })
}

async function insertMeeting(opts: {
  userId: string
  title?: string
  date?: Date
  scheduledEndAt?: Date | null
  durationSeconds?: number
  transcriptSegments?: unknown
  speakerMap?: Record<string, string>
  notes?: string
  summary?: string | null
  wasImpromptu?: boolean
  attendees?: string[] | null
  attendeeEmails?: string[] | null
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: opts.title ?? 'Test Meeting',
    date: opts.date ?? new Date(),
    scheduledEndAt: opts.scheduledEndAt ?? null,
    durationSeconds: opts.durationSeconds ?? 1800,
    status: 'completed',
    transcriptSegments: opts.transcriptSegments ?? null,
    speakerMap: opts.speakerMap ?? {},
    notes: opts.notes ?? null,
    summary: opts.summary ?? null,
    wasImpromptu: opts.wasImpromptu ?? false,
    attendees: (opts.attendees === undefined
      ? ['Alice', 'Bob']
      : opts.attendees) as never,
    attendeeEmails: (opts.attendeeEmails === undefined
      ? ['alice@example.com', 'bob@example.com']
      : opts.attendeeEmails) as never,
    speakerCount: 2,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
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
      scheduledEndAt: new Date('2026-05-15T11:00:00Z'),
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
    // T12: scheduledEndAt round-trips on the GET response.
    expect((body as unknown as { scheduledEndAt: string | null }).scheduledEndAt).toBe(
      '2026-05-15T11:00:00.000Z',
    )
    expect(body.durationSeconds).toBe(1800)
    expect(body.status).toBe('completed')
    expect(body.wasImpromptu).toBe(false)
    expect(body.notes).toBe('Discussed roadmap.')

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
    expect(body.linkedCompanies).toEqual([
      { id: companyId, name: 'Acme Corp ' + TEST_PREFIX, primaryDomain: null },
    ])
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

  test('Item 2: surfaces summary column round-trip (populated)', async () => {
    const userId = await insertTestUser()
    const md = '# Recap\n\n- Discussed roadmap\n- Decided on Q3 launch'
    const meetingId = await insertMeeting({ userId, summary: md })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: string | null }
    expect(body.summary).toBe(md)
  })

  test('Item 2: summary defaults to null when column is empty (pre-migration / unsummarized)', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({ userId })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { summary: string | null }
    expect(body.summary).toBeNull()
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

  // ─── attendeeContacts resolution ──────────────────────────────────────
  // Mirrors desktop's two-table lookup (contacts.email + contact_emails.email)
  // at packages/db/src/sqlite/repositories/contact.repo.ts:429-439.
  // Scoped by user_id so cross-tenant data can't leak via shared email.
  test('attendeeContacts resolves primary email to contactId + contactFullName; unmatched emails are null', async () => {
    const userId = await insertTestUser()
    const matchedEmail = `priya-${TEST_PREFIX}@example.com`
    const matchedFullName = 'Priya ' + TEST_PREFIX
    const matchedContactId = await insertContact({
      userId,
      fullName: matchedFullName,
      email: matchedEmail,
    })
    const meetingId = await insertMeeting({
      userId,
      attendees: ['Priya', 'Stranger'],
      attendeeEmails: [matchedEmail, `unknown-${TEST_PREFIX}@example.com`],
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      attendeeContacts: Array<{
        name: string
        email: string | null
        contactId: string | null
        contactFullName: string | null
      }>
    }
    expect(body.attendeeContacts).toEqual([
      {
        name: 'Priya',
        email: matchedEmail,
        contactId: matchedContactId,
        contactFullName: matchedFullName,
      },
      {
        name: 'Stranger',
        email: `unknown-${TEST_PREFIX}@example.com`,
        contactId: null,
        contactFullName: null,
      },
    ])
  })

  test('attendeeContacts resolves emails case-insensitively', async () => {
    const userId = await insertTestUser()
    const storedEmail = `Mixed.Case-${TEST_PREFIX}@Example.COM`
    const matchedFullName = 'Casey ' + TEST_PREFIX
    const matchedContactId = await insertContact({
      userId,
      fullName: matchedFullName,
      email: storedEmail,
    })
    const attendeeEmail = storedEmail.toLowerCase()
    const meetingId = await insertMeeting({
      userId,
      attendees: ['Casey'],
      attendeeEmails: [attendeeEmail],
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      attendeeContacts: Array<{
        name: string
        email: string | null
        contactId: string | null
        contactFullName: string | null
      }>
    }
    expect(body.attendeeContacts).toEqual([
      {
        name: 'Casey',
        email: attendeeEmail,
        contactId: matchedContactId,
        contactFullName: matchedFullName,
      },
    ])
  })

  test('attendeeContacts resolves via contact_emails alias table (not just primary email)', async () => {
    const userId = await insertTestUser()
    const primaryEmail = `primary-${TEST_PREFIX}@example.com`
    const aliasEmail = `work-alias-${TEST_PREFIX}@example.com`
    const matchedFullName = 'Alias-Owner ' + TEST_PREFIX
    const matchedContactId = await insertContact({
      userId,
      fullName: matchedFullName,
      email: primaryEmail,
    })
    await insertContactEmailAlias(matchedContactId, aliasEmail)

    const meetingId = await insertMeeting({
      userId,
      attendees: ['Alias-Owner'],
      // Attendee is invited via the alias, not the primary email.
      attendeeEmails: [aliasEmail],
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      attendeeContacts: Array<{
        name: string
        email: string | null
        contactId: string | null
        contactFullName: string | null
      }>
    }
    expect(body.attendeeContacts).toEqual([
      {
        name: 'Alias-Owner',
        email: aliasEmail,
        contactId: matchedContactId,
        contactFullName: matchedFullName,
      },
    ])
  })

  test('attendeeContacts does not leak contacts across user_id (cross-tenant safety)', async () => {
    const ownerA = await insertTestUser()
    const ownerB = await insertTestUser()
    // Owner B has a contact with this exact email. Owner A's meeting should
    // NOT pick up B's contact when its own attendee list happens to include
    // the same email — the user_id scope must filter it out.
    const sharedEmail = `shared-${TEST_PREFIX}@example.com`
    await insertContact({
      userId: ownerB,
      fullName: 'Bs Contact ' + TEST_PREFIX,
      email: sharedEmail,
    })

    const meetingId = await insertMeeting({
      userId: ownerA,
      attendees: ['Some Person'],
      attendeeEmails: [sharedEmail],
    })

    const jwt = await mintJwt(ownerA)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      attendeeContacts: Array<{
        name: string
        email: string | null
        contactId: string | null
        contactFullName: string | null
      }>
    }
    // contactId + contactFullName must be null — B's contact must not leak into A's meeting.
    expect(body.attendeeContacts).toEqual([
      { name: 'Some Person', email: sharedEmail, contactId: null, contactFullName: null },
    ])
  })

  test('attendeeContacts is [] when meeting has no attendees', async () => {
    const userId = await insertTestUser()
    const meetingId = await insertMeeting({
      userId,
      attendees: null,
      attendeeEmails: null,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { attendeeContacts: unknown[] }
    expect(body.attendeeContacts).toEqual([])
  })
})
