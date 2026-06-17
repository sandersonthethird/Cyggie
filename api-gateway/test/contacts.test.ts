import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// /contacts surface against the dev Neon DB. Same teardown pattern as
// companies.test.ts.

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

const TEST_PREFIX = `test-ct-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
// Kept for in-test result filtering only — cleanup is routed through the helper.
const createdContactIds: string[] = []

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

async function insertTestCompany(opts: {
  userId: string
  name: string
  primaryDomain?: string | null
}): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId: opts.userId,
    canonicalName: opts.name,
    normalizedName: opts.name.toLowerCase(),
    primaryDomain: opts.primaryDomain ?? null,
    status: 'active',
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

async function insertTestContact(opts: {
  userId: string
  fullName: string
  email?: string
  title?: string
  companyId?: string
  lastMeetingAt?: Date
  contactType?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId: opts.userId,
    fullName: opts.fullName,
    normalizedName: opts.fullName.toLowerCase(),
    email: opts.email ?? null,
    title: opts.title ?? null,
    primaryCompanyId: opts.companyId ?? null,
    contactType: opts.contactType ?? null,
    lastMeetingAt: opts.lastMeetingAt ?? null,
  })
  cleanup.track(schema.contacts, schema.contacts.id, id)
  createdContactIds.push(id)
  return id
}

async function insertMeetingWithSpeakerLink(opts: {
  userId: string
  contactId: string
  date: Date
  title?: string
}): Promise<string> {
  const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id: meetingId,
    userId: opts.userId,
    title: opts.title ?? 'Test Meeting',
    date: opts.date,
    durationSeconds: 1800,
    status: 'completed',
  })
  cleanup.track(schema.meetings, schema.meetings.id, meetingId)
  // Tie the meeting to the contact via speaker_contact_links.
  // speakerIndex is arbitrary — primary key is (meetingId, speakerIndex).
  await db.insert(schema.meetingSpeakerContactLinks).values({
    meetingId,
    speakerIndex: 1,
    contactId: opts.contactId,
  })
  return meetingId
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

describe('GET /contacts', () => {
  test('returns contacts for caller, sorted by last-meeting DESC nulls last', async () => {
    const userId = await insertTestUser()
    const companyId = await insertTestCompany({
      userId,
      name: 'Hosting Co ' + TEST_PREFIX,
      primaryDomain: 'hosting.example',
    })

    const oldId = await insertTestContact({
      userId,
      fullName: 'Old Alice ' + TEST_PREFIX,
      lastMeetingAt: new Date('2026-01-01T10:00:00Z'),
      companyId,
    })
    const recentId = await insertTestContact({
      userId,
      fullName: 'Recent Bob ' + TEST_PREFIX,
      lastMeetingAt: new Date('2026-05-15T10:00:00Z'),
      companyId,
    })
    const untouchedId = await insertTestContact({
      userId,
      fullName: 'Untouched Carol ' + TEST_PREFIX,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/contacts?limit=100',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      contacts: Array<{
        id: string
        fullName: string
        lastMeetingAt: string | null
        primaryCompanyName: string | null
        primaryCompanyDomain: string | null
      }>
    }

    const ours = body.contacts.filter((c) => createdContactIds.includes(c.id))
    expect(ours.length).toBe(3)

    const positions = {
      recent: ours.findIndex((c) => c.id === recentId),
      old: ours.findIndex((c) => c.id === oldId),
      untouched: ours.findIndex((c) => c.id === untouchedId),
    }
    expect(positions.recent).toBeLessThan(positions.old)
    expect(positions.old).toBeLessThan(positions.untouched)

    // Company name + domain joined in via LEFT JOIN. The untouched contact
    // has no primary_company_id, so a misconfigured INNER JOIN would drop
    // it from the result entirely — that's the regression this guards.
    expect(ours.find((c) => c.id === recentId)?.primaryCompanyName).toBe(
      'Hosting Co ' + TEST_PREFIX,
    )
    expect(ours.find((c) => c.id === recentId)?.primaryCompanyDomain).toBe(
      'hosting.example',
    )
    expect(ours.find((c) => c.id === untouchedId)?.primaryCompanyName).toBeNull()
    expect(ours.find((c) => c.id === untouchedId)?.primaryCompanyDomain).toBeNull()
  })

  test('user isolation: caller cannot see another user contacts', async () => {
    const userA = await insertTestUser()
    const userB = await insertTestUser()

    const ctA = await insertTestContact({ userId: userA, fullName: 'A Person ' + TEST_PREFIX })
    const ctB = await insertTestContact({ userId: userB, fullName: 'B Person ' + TEST_PREFIX })

    const jwtA = await mintJwt(userA)
    const res = await app.inject({
      method: 'GET',
      url: '/contacts?limit=100',
      headers: { authorization: `Bearer ${jwtA}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { contacts: Array<{ id: string }> }
    const ids = body.contacts.map((c) => c.id)
    expect(ids).toContain(ctA)
    expect(ids).not.toContain(ctB)
  })

  test('?q= matches full_name OR email', async () => {
    const userId = await insertTestUser()
    const byName = await insertTestContact({
      userId,
      fullName: 'Priya Patel ' + TEST_PREFIX,
    })
    const byEmail = await insertTestContact({
      userId,
      fullName: 'Different Person ' + TEST_PREFIX,
      email: `priya-${TEST_PREFIX}@searchhit.io`,
    })
    await insertTestContact({
      userId,
      fullName: 'Unrelated ' + TEST_PREFIX,
      email: `nobody-${TEST_PREFIX}@elsewhere.io`,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/contacts?q=priya',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { contacts: Array<{ id: string }> }
    const ourMatched = body.contacts
      .filter((c) => createdContactIds.includes(c.id))
      .map((c) => c.id)
      .sort()
    expect(ourMatched).toEqual([byName, byEmail].sort())
  })

  test('401 when no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/contacts' })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /contacts/:id', () => {
  test('returns detail + recent meetings via speaker_contact_links', async () => {
    const userId = await insertTestUser()
    const companyId = await insertTestCompany({
      userId,
      name: 'Detail Co ' + TEST_PREFIX,
      primaryDomain: 'detail.example',
    })
    const contactId = await insertTestContact({
      userId,
      fullName: 'Founder Felipe ' + TEST_PREFIX,
      email: `felipe-${TEST_PREFIX}@startup.io`,
      title: 'CEO',
      companyId,
      contactType: 'founder',
      lastMeetingAt: new Date('2026-05-10T10:00:00Z'),
    })

    const m1 = await insertMeetingWithSpeakerLink({
      userId,
      contactId,
      date: new Date('2026-04-01T10:00:00Z'),
      title: 'First meeting',
    })
    const m2 = await insertMeetingWithSpeakerLink({
      userId,
      contactId,
      date: new Date('2026-05-10T10:00:00Z'),
      title: 'Second meeting',
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/contacts/${contactId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      fullName: string
      email: string | null
      title: string | null
      contactType: string | null
      primaryCompanyId: string | null
      primaryCompanyName: string | null
      primaryCompanyDomain: string | null
      lastMeetingAt: string | null
      lastTouchAt: string | null
      recentMeetings: Array<{ id: string; title: string; date: string }>
    }

    expect(body.id).toBe(contactId)
    expect(body.fullName).toBe('Founder Felipe ' + TEST_PREFIX)
    expect(body.email).toBe(`felipe-${TEST_PREFIX}@startup.io`)
    expect(body.title).toBe('CEO')
    expect(body.contactType).toBe('founder')
    expect(body.primaryCompanyId).toBe(companyId)
    expect(body.primaryCompanyName).toBe('Detail Co ' + TEST_PREFIX)
    expect(body.primaryCompanyDomain).toBe('detail.example')
    expect(body.lastMeetingAt).toBe('2026-05-10T10:00:00.000Z')
    // lastTouchAt is the max of the live meeting subquery + denormalized
    // lastEmailAt. No emails here, so it equals the latest meeting date.
    expect(body.lastTouchAt).toBe('2026-05-10T10:00:00.000Z')

    // Meetings sorted DESC by date.
    expect(body.recentMeetings[0]?.id).toBe(m2)
    expect(body.recentMeetings[1]?.id).toBe(m1)
  })

  test('404 when contact belongs to a different user', async () => {
    const owner = await insertTestUser()
    const intruder = await insertTestUser()
    const contactId = await insertTestContact({
      userId: owner,
      fullName: 'Private Person ' + TEST_PREFIX,
    })

    const jwt = await mintJwt(intruder)
    const res = await app.inject({
      method: 'GET',
      url: `/contacts/${contactId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'CONTACT_NOT_FOUND' } })
  })

  test('404 for non-existent id', async () => {
    const userId = await insertTestUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/contacts/does-not-exist',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /contacts/:id — guarded passthrough', () => {
  const FORBIDDEN_KEYS = [
    'userId', 'lamport', 'fieldSources', 'createdByUserId', 'updatedByUserId',
    'createdAt', 'updatedAt', 'normalizedName', 'crmContactId', 'crmProvider',
    // Heavy JSONB denylisted (decision 2A) — never on the wire.
    'workHistory', 'educationHistory', 'linkedinSkills', 'linkedinEnrichedAt', 'otherSocials',
  ]

  test('surfaces investor + JSONB-list fields and leaks no internal column', async () => {
    const userId = await insertTestUser()
    const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
    await db.insert(schema.contacts).values({
      id,
      userId,
      fullName: 'Iris Investor ' + TEST_PREFIX,
      normalizedName: ('iris investor ' + TEST_PREFIX).toLowerCase(),
      contactType: 'investor',
      relationshipStrength: 'strong',
      fundSize: 50_000_000,
      typicalCheckSizeMin: 250_000,
      typicalCheckSizeMax: 1_000_000,
      university: 'Stanford',
      tags: ['ai', 'infra'],
      investmentStageFocus: ['seed', 'series_a'],
      proudPortfolioCompanies: [{ name: 'Acme' }, { name: 'Globex' }],
    })
    cleanup.track(schema.contacts, schema.contacts.id, id)

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/contacts/${id}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    expect(body['contactType']).toBe('investor')
    expect(body['university']).toBe('Stanford')
    expect(body['fundSize']).toBe(50_000_000)
    // JSONB lists normalized to string[] (objects → their name).
    expect(body['tags']).toEqual(['ai', 'infra'])
    expect(body['investmentStageFocus']).toEqual(['seed', 'series_a'])
    expect(body['proudPortfolioCompanies']).toEqual(['Acme', 'Globex'])

    for (const k of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(body, k), `internal key "${k}" leaked`).toBe(false)
    }
  })
})
