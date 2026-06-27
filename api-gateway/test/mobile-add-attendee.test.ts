import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Mobile add-attendee / add-company flow (2026-05-24). Covers:
//   - POST /contacts                       create-on-the-fly (no enrichment)
//   - POST /companies                      create-on-the-fly (no enrichment)
//   - PATCH /meetings/:id                  attendees/attendeeEmails arrays
//   - POST /meetings/:id/companies         link existing company
//   - DELETE /meetings/:id/companies/:companyId   unlink

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

const TEST_PREFIX = `test-mobile-add-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

// POST /contacts now stamps firm_id onto the row (FK → firms), so the JWT
// firm_id must reference a real firm or the insert FK-violates (500). One
// shared firm for the file (onConflictDoNothing keeps setupUser idempotent).
const SHARED_FIRM_ID = TEST_PREFIX + 'firm'

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db
    .insert(schema.firms)
    .values({ id: SHARED_FIRM_ID, name: 'Add-Attendee Test Firm', slug: SHARED_FIRM_ID })
    .onConflictDoNothing()
  cleanup.track(schema.firms, schema.firms.id, SHARED_FIRM_ID)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    firmId: SHARED_FIRM_ID,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: SHARED_FIRM_ID,
    role: 'member',
  })
  return { userId, jwt }
}

async function insertMeeting(userId: string, lamport = '1'): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title: 'Test Meeting',
    date: new Date('2026-05-24T10:00:00Z'),
    status: 'scheduled',
    lamport,
    createdByUserId: userId,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function insertCompany(userId: string, canonicalName: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName,
    normalizedName: canonicalName.toLowerCase().replace(/\s+/g, ' ').trim(),
    status: 'active',
    entityType: 'unknown',
    classificationSource: 'manual',
    lamport: '1',
    createdByUserId: userId,
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

describe('POST /contacts', () => {
  test('201 — creates a contact with just fullName, no enrichment', async () => {
    const { userId, jwt } = await setupUser()
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { fullName: 'Ada Lovelace' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; fullName: string; email: string | null }
    expect(body.fullName).toBe('Ada Lovelace')
    expect(body.email).toBeNull()
    cleanup.track(schema.contacts, schema.contacts.id, body.id)

    // Verify the row matches: normalized_name + lamport set, user_id stamped.
    const row = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, body.id) })
    expect(row?.userId).toBe(userId)
    expect(row?.normalizedName).toBe('ada lovelace')
    expect(row?.lamport).not.toBe('0')
  })

  test('201 — creates a contact with email, inserts contact_emails row', async () => {
    const { userId, jwt } = await setupUser()
    const email = `ada-${createId().slice(0, 6)}@example.com`
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { fullName: 'Ada L', email },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; email: string }
    expect(body.email).toBe(email)
    cleanup.track(schema.contacts, schema.contacts.id, body.id)

    // contact_emails row is the canonical store; verify it exists.
    const emails = await db.query.contactEmails.findMany({
      where: eq(schema.contactEmails.contactId, body.id),
    })
    expect(emails).toHaveLength(1)
    expect(emails[0]?.email).toBe(email)
    expect(emails[0]?.isPrimary).toBe(1)
    void userId
  })

  test('409 — duplicate email returns existing contact (substitution path)', async () => {
    const { jwt } = await setupUser()
    const email = `dup-${createId().slice(0, 6)}@example.com`
    const first = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { fullName: 'Alpha', email },
    })
    expect(first.statusCode).toBe(201)
    const firstId = (first.json() as { id: string }).id
    cleanup.track(schema.contacts, schema.contacts.id, firstId)

    const second = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { fullName: 'Beta', email }, // same email
    })
    expect(second.statusCode).toBe(409)
    const dup = second.json() as { id: string; fullName: string }
    expect(dup.id).toBe(firstId)
    expect(dup.fullName).toBe('Alpha') // existing wins
  })

  test('401 — without JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      payload: { fullName: 'Alice' },
    })
    expect(res.statusCode).toBe(401)
  })

  test('400 — empty fullName', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'POST',
      url: '/contacts',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { fullName: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /companies', () => {
  test('201 — creates a company with just canonicalName, no enrichment', async () => {
    const { userId, jwt } = await setupUser()
    const name = `Acme ${createId().slice(0, 6)}`
    const res = await app.inject({
      method: 'POST',
      url: '/companies',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { canonicalName: name },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; name: string }
    expect(body.name).toBe(name)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, body.id)

    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, body.id),
    })
    expect(row?.userId).toBe(userId)
    expect(row?.classificationSource).toBe('manual')
    expect(row?.lamport).not.toBe('0')
  })

  test('409 — duplicate normalized name returns existing company', async () => {
    const { jwt } = await setupUser()
    const name = `Beta ${createId().slice(0, 6)}`
    const first = await app.inject({
      method: 'POST',
      url: '/companies',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { canonicalName: name },
    })
    expect(first.statusCode).toBe(201)
    const firstId = (first.json() as { id: string }).id
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, firstId)

    // Different casing/punctuation should normalize to the same key.
    const second = await app.inject({
      method: 'POST',
      url: '/companies',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { canonicalName: name.toUpperCase() },
    })
    expect(second.statusCode).toBe(409)
    const dup = second.json() as { id: string }
    expect(dup.id).toBe(firstId)
  })

  test('401 — without JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/companies',
      payload: { canonicalName: 'Acme' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('PATCH /meetings/:id — attendees + attendeeEmails', () => {
  test('200 — happy path: updates both arrays + lamport advances', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId, '5')

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        attendees: ['Ada', 'Charles'],
        attendeeEmails: ['ada@example.com', ''],
        lamport: '6',
      },
    })
    expect(res.statusCode).toBe(200)
    const row = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    expect(row?.attendees).toEqual(['Ada', 'Charles'])
    expect(row?.attendeeEmails).toEqual(['ada@example.com', ''])
    expect(row?.lamport).toBe('6')
    expect(row?.updatedByUserId).toBe(userId)
  })

  test('200 — notes-only updates still work (back-compat)', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId, '5')

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { notes: 'just notes', lamport: '6' },
    })
    expect(res.statusCode).toBe(200)
    void userId
  })

  test('400 — attendees and attendeeEmails must be the same length', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId, '5')
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        attendees: ['A', 'B'],
        attendeeEmails: ['a@x.com'], // length mismatch
        lamport: '6',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  test('400 — attendees without attendeeEmails (must be sent together)', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId, '5')
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { attendees: ['A'], lamport: '6' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('400 — empty body (no fields)', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId, '5')
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { lamport: '6' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('409 — stale lamport on attendee update', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId, '10')
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { attendees: ['A'], attendeeEmails: [''], lamport: '5' },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('POST /meetings/:id/companies — link', () => {
  test('200 — links company; writes both meeting_company_links + JSONB cache', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId)
    const companyId = await insertCompany(userId, 'Stripe ' + createId().slice(0, 6))

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/companies`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { companyId, lamport: '10' },
    })
    expect(res.statusCode).toBe(200)

    const link = await db.query.meetingCompanyLinks.findFirst({
      where: and(
        eq(schema.meetingCompanyLinks.meetingId, meetingId),
        eq(schema.meetingCompanyLinks.companyId, companyId),
      ),
    })
    expect(link).toBeDefined()
    expect(link?.linkedBy).toBe('manual')

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    const company = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect((meeting?.companies as string[] | null) ?? []).toContain(company?.canonicalName)
  })

  test('200 — idempotent: re-link returns 200, no duplicate row', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId)
    const companyId = await insertCompany(userId, 'Idem ' + createId().slice(0, 6))

    await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/companies`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { companyId, lamport: '10' },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/companies`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { companyId, lamport: '11' },
    })
    expect(res2.statusCode).toBe(200)

    const links = await db.query.meetingCompanyLinks.findMany({
      where: and(
        eq(schema.meetingCompanyLinks.meetingId, meetingId),
        eq(schema.meetingCompanyLinks.companyId, companyId),
      ),
    })
    expect(links).toHaveLength(1)
  })

  test('404 — meeting belongs to another user (no existence leak)', async () => {
    const alice = await setupUser()
    const bob = await setupUser()
    const meetingId = await insertMeeting(alice.userId)
    const bobCompany = await insertCompany(bob.userId, 'BobCo ' + createId().slice(0, 6))

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/companies`,
      headers: { authorization: `Bearer ${bob.jwt}`, 'content-type': 'application/json' },
      payload: { companyId: bobCompany, lamport: '10' },
    })
    expect(res.statusCode).toBe(404)
  })

  test('404 — company belongs to another user', async () => {
    const alice = await setupUser()
    const bob = await setupUser()
    const meetingId = await insertMeeting(alice.userId)
    const bobCompany = await insertCompany(bob.userId, 'BobCo ' + createId().slice(0, 6))

    const res = await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/companies`,
      headers: { authorization: `Bearer ${alice.jwt}`, 'content-type': 'application/json' },
      payload: { companyId: bobCompany, lamport: '10' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /meetings/:id/companies/:companyId — unlink', () => {
  test('200 — removes link + splices JSONB cache', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId)
    const companyId = await insertCompany(userId, 'Unlink ' + createId().slice(0, 6))

    // First link.
    await app.inject({
      method: 'POST',
      url: `/meetings/${meetingId}/companies`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { companyId, lamport: '10' },
    })

    // Then unlink.
    const res = await app.inject({
      method: 'DELETE',
      url: `/meetings/${meetingId}/companies/${companyId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { lamport: '11' },
    })
    expect(res.statusCode).toBe(200)

    const link = await db.query.meetingCompanyLinks.findFirst({
      where: and(
        eq(schema.meetingCompanyLinks.meetingId, meetingId),
        eq(schema.meetingCompanyLinks.companyId, companyId),
      ),
    })
    expect(link).toBeUndefined()

    const meeting = await db.query.meetings.findFirst({
      where: eq(schema.meetings.id, meetingId),
    })
    const company = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect((meeting?.companies as string[] | null) ?? []).not.toContain(company?.canonicalName)
  })

  test('200 — idempotent: unlink-not-linked is a no-op', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting(userId)
    const companyId = await insertCompany(userId, 'NoLink ' + createId().slice(0, 6))

    const res = await app.inject({
      method: 'DELETE',
      url: `/meetings/${meetingId}/companies/${companyId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { lamport: '10' },
    })
    expect(res.statusCode).toBe(200)
  })

  test('404 — meeting owned by another user', async () => {
    const alice = await setupUser()
    const bob = await setupUser()
    const meetingId = await insertMeeting(alice.userId)
    const companyId = await insertCompany(bob.userId, 'Hidden ' + createId().slice(0, 6))

    const res = await app.inject({
      method: 'DELETE',
      url: `/meetings/${meetingId}/companies/${companyId}`,
      headers: { authorization: `Bearer ${bob.jwt}`, 'content-type': 'application/json' },
      payload: { lamport: '10' },
    })
    expect(res.statusCode).toBe(404)
  })
})
