import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Tests the M2 /companies surface against the live Neon dev DB. Same pattern
// as firms.flow.test.ts: TEST_PREFIX-tagged rows + afterAll teardown.

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

const TEST_PREFIX = `test-cmp-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdCompanyIds: string[] = []
const createdMeetingIds: string[] = []
const createdContactIds: string[] = []

afterAll(async () => {
  // meeting_company_links + contacts cascade via FK ON DELETE CASCADE on
  // meetings/companies, so deleting parents is enough.
  if (createdContactIds.length > 0) {
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, createdContactIds))
  }
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
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

async function insertTestCompany(opts: {
  userId: string
  name: string
  industry?: string
  pipelineStage?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId: opts.userId,
    canonicalName: opts.name,
    normalizedName: opts.name.toLowerCase(),
    industry: opts.industry ?? null,
    pipelineStage: opts.pipelineStage ?? null,
    status: 'active',
  })
  createdCompanyIds.push(id)
  return id
}

async function insertTestMeeting(opts: {
  userId: string
  companyId: string
  date: Date
  title?: string
  durationSeconds?: number
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: opts.title ?? 'Test Meeting',
    date: opts.date,
    durationSeconds: opts.durationSeconds ?? 1800,
    status: 'completed',
  })
  createdMeetingIds.push(id)
  await db.insert(schema.meetingCompanyLinks).values({
    meetingId: id,
    companyId: opts.companyId,
    confidence: 1.0,
    linkedBy: 'manual',
  })
  return id
}

async function insertTestContact(opts: {
  userId: string
  companyId: string
  fullName: string
  title?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId: opts.userId,
    fullName: opts.fullName,
    normalizedName: opts.fullName.toLowerCase(),
    primaryCompanyId: opts.companyId,
    title: opts.title ?? null,
  })
  createdContactIds.push(id)
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

describe('GET /companies', () => {
  test('returns companies for the calling user, sorted by last-touch DESC', async () => {
    const userId = await insertTestUser()

    // Three companies; two have meetings (so they get a last-touch), one doesn't.
    const oldCoId = await insertTestCompany({ userId, name: 'AlphaCo ' + TEST_PREFIX })
    const recentCoId = await insertTestCompany({ userId, name: 'BetaCo ' + TEST_PREFIX })
    const untouchedCoId = await insertTestCompany({ userId, name: 'GammaCo ' + TEST_PREFIX })

    await insertTestMeeting({
      userId,
      companyId: oldCoId,
      date: new Date('2026-01-01T10:00:00Z'),
    })
    await insertTestMeeting({
      userId,
      companyId: recentCoId,
      date: new Date('2026-05-01T10:00:00Z'),
    })
    await insertTestMeeting({
      userId,
      companyId: recentCoId,
      date: new Date('2026-05-10T10:00:00Z'),
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/companies?limit=100',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      companies: Array<{
        id: string
        name: string
        lastTouchAt: string | null
        meetingCount: number
      }>
      total: number
    }

    // Filter to just our test rows — the dev DB may have other test artifacts.
    const ours = body.companies.filter((c) => createdCompanyIds.includes(c.id))
    expect(ours.length).toBe(3)

    // Recent-touch first, then older-touch, then nulls.
    const positions = {
      recent: ours.findIndex((c) => c.id === recentCoId),
      old: ours.findIndex((c) => c.id === oldCoId),
      untouched: ours.findIndex((c) => c.id === untouchedCoId),
    }
    expect(positions.recent).toBeLessThan(positions.old)
    expect(positions.old).toBeLessThan(positions.untouched)

    // Meeting counts.
    expect(ours.find((c) => c.id === recentCoId)?.meetingCount).toBe(2)
    expect(ours.find((c) => c.id === oldCoId)?.meetingCount).toBe(1)
    expect(ours.find((c) => c.id === untouchedCoId)?.meetingCount).toBe(0)

    // Untouched company has no lastTouchAt.
    expect(ours.find((c) => c.id === untouchedCoId)?.lastTouchAt).toBeNull()
  })

  test('user isolation: caller A cannot see caller B companies', async () => {
    const userA = await insertTestUser()
    const userB = await insertTestUser()

    const coA = await insertTestCompany({ userId: userA, name: 'Acme A ' + TEST_PREFIX })
    const coB = await insertTestCompany({ userId: userB, name: 'Acme B ' + TEST_PREFIX })

    const jwtA = await mintJwt(userA)
    const res = await app.inject({
      method: 'GET',
      url: '/companies?limit=100',
      headers: { authorization: `Bearer ${jwtA}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { companies: Array<{ id: string }> }
    const ids = body.companies.map((c) => c.id)
    expect(ids).toContain(coA)
    expect(ids).not.toContain(coB)
  })

  test('?q= filters by canonical name (case-insensitive substring)', async () => {
    const userId = await insertTestUser()
    await insertTestCompany({ userId, name: 'Stripe Labs ' + TEST_PREFIX })
    const targetId = await insertTestCompany({
      userId,
      name: 'Plaid Networks ' + TEST_PREFIX,
    })
    await insertTestCompany({ userId, name: 'Brex Cards ' + TEST_PREFIX })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/companies?q=plaid',
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { companies: Array<{ id: string; name: string }> }
    const ourIds = body.companies
      .filter((c) => createdCompanyIds.includes(c.id))
      .map((c) => c.id)
    expect(ourIds).toEqual([targetId])
  })

  test('pagination via limit + offset', async () => {
    const userId = await insertTestUser()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await insertTestCompany({ userId, name: `Page Co ${i} ` + TEST_PREFIX }),
      )
    }

    const jwt = await mintJwt(userId)
    const page1 = await app.inject({
      method: 'GET',
      url: '/companies?limit=2&offset=0',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json() as {
      companies: Array<{ id: string }>
      total: number
    }
    expect(body1.companies.length).toBe(2)
    expect(body1.total).toBe(5)

    const page2 = await app.inject({
      method: 'GET',
      url: '/companies?limit=2&offset=2',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body2 = page2.json() as { companies: Array<{ id: string }> }
    expect(body2.companies.length).toBe(2)

    // No overlap between page 1 and page 2.
    const p1ids = new Set(body1.companies.map((c) => c.id))
    for (const c of body2.companies) expect(p1ids.has(c.id)).toBe(false)
  })

  test('401 when no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/companies' })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /companies/:id', () => {
  test('returns detail with recent meetings + linked people', async () => {
    const userId = await insertTestUser()
    const coId = await insertTestCompany({
      userId,
      name: 'Detail Co ' + TEST_PREFIX,
      industry: 'Fintech',
      pipelineStage: 'due_diligence',
    })

    const m1 = await insertTestMeeting({
      userId,
      companyId: coId,
      date: new Date('2026-04-01T10:00:00Z'),
      title: 'Old meeting',
    })
    const m2 = await insertTestMeeting({
      userId,
      companyId: coId,
      date: new Date('2026-05-15T10:00:00Z'),
      title: 'Recent meeting',
    })

    const p1 = await insertTestContact({
      userId,
      companyId: coId,
      fullName: 'Alice Founder',
      title: 'CEO',
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${coId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      name: string
      industry: string | null
      pipelineStage: string | null
      meetingCount: number
      lastTouchAt: string | null
      recentMeetings: Array<{ id: string; title: string; date: string }>
      people: Array<{ id: string; fullName: string; title: string | null }>
    }

    expect(body.id).toBe(coId)
    expect(body.industry).toBe('Fintech')
    expect(body.pipelineStage).toBe('due_diligence')
    expect(body.meetingCount).toBe(2)
    expect(body.lastTouchAt).toBe('2026-05-15T10:00:00.000Z')

    // Recent meetings sorted DESC by date.
    expect(body.recentMeetings[0]?.id).toBe(m2)
    expect(body.recentMeetings[1]?.id).toBe(m1)

    expect(body.people).toHaveLength(1)
    expect(body.people[0]?.id).toBe(p1)
    expect(body.people[0]?.fullName).toBe('Alice Founder')
  })

  test('404 when company belongs to a different user', async () => {
    const owner = await insertTestUser()
    const intruder = await insertTestUser()
    const coId = await insertTestCompany({
      userId: owner,
      name: 'Private Co ' + TEST_PREFIX,
    })

    const intruderJwt = await mintJwt(intruder)
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${coId}`,
      headers: { authorization: `Bearer ${intruderJwt}` },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'COMPANY_NOT_FOUND' } })
  })

  test('404 for non-existent id', async () => {
    const userId = await insertTestUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/companies/does-not-exist',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(404)
  })
})
