import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

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
const cleanup = makeDbCleanup(db)
// Kept for in-test result filtering only — cleanup is routed through the helper.
const createdCompanyIds: string[] = []

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
  industry?: string
  pipelineStage?: string
  primaryDomain?: string | null
}): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId: opts.userId,
    canonicalName: opts.name,
    normalizedName: opts.name.toLowerCase(),
    industry: opts.industry ?? null,
    pipelineStage: opts.pipelineStage ?? null,
    primaryDomain: opts.primaryDomain ?? null,
    status: 'active',
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
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
  cleanup.track(schema.meetings, schema.meetings.id, id)
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
  cleanup.track(schema.contacts, schema.contacts.id, id)
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
    // recentCoId gets a primaryDomain so the list response can be checked
    // for the field — the others stay null to confirm we don't crash on null.
    const oldCoId = await insertTestCompany({ userId, name: 'AlphaCo ' + TEST_PREFIX })
    const recentCoId = await insertTestCompany({
      userId,
      name: 'BetaCo ' + TEST_PREFIX,
      primaryDomain: 'beta.example',
    })
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

describe('GET /companies/:id — guarded passthrough', () => {
  // Internal/audit/sync columns that must NEVER reach a client. This doubles as
  // the security guard for `.passthrough()` (sanitize-row denylist + pattern).
  const FORBIDDEN_KEYS = [
    'userId', 'firmId', 'fieldSources', 'fieldLamports', 'lamport',
    'createdByUserId', 'updatedByUserId', 'createdAt', 'updatedAt',
    'normalizedName', 'canonicalName', 'crmCompanyId',
    'crmProvider', 'leadInvestorCompanyId', 'sourceEntityId', 'sourceEntityType',
    'deletedAt', 'deletedByUserId', 'classificationSource', 'includeInCompaniesView',
  ]

  test('surfaces business/investment fields and leaks no internal column', async () => {
    const userId = await insertTestUser()
    const coId = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    await db.insert(schema.orgCompanies).values({
      id: coId,
      userId,
      canonicalName: 'Amma Test ' + TEST_PREFIX,
      normalizedName: ('amma test ' + TEST_PREFIX).toLowerCase(),
      status: 'active',
      industry: 'AI Infra, Dev Tools',
      portfolioFund: 'fund_iv',
      investmentSize: '500000',
      ownershipPct: '5%',
      initialInvestmentSecurity: 'safe',
      dateOfInitialInvestment: new Date('2026-04-14T00:00:00Z'),
      postMoneyValuation: 10,
      round: 'pre_seed',
      raiseSize: 2,
      twitterHandle: 'amma',
    })
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, coId)

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${coId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    // The Amma fix: investment/financial columns now reach mobile.
    expect(body['name']).toBe('Amma Test ' + TEST_PREFIX)
    expect(body['portfolioFund']).toBe('fund_iv')
    expect(body['investmentSize']).toBe('500000')
    expect(body['ownershipPct']).toBe('5%')
    expect(body['initialInvestmentSecurity']).toBe('safe')
    expect(body['postMoneyValuation']).toBe(10)
    expect(body['round']).toBe('pre_seed')
    expect(typeof body['dateOfInitialInvestment']).toBe('string') // Date → ISO

    // Leak guard.
    for (const k of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(body, k), `internal key "${k}" leaked`).toBe(false)
    }
  })

  test('sparse company returns null for unset business fields', async () => {
    const userId = await insertTestUser()
    const coId = await insertTestCompany({ userId, name: 'Sparse Co ' + TEST_PREFIX })
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${coId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as Record<string, unknown>
    expect(body['portfolioFund'] ?? null).toBeNull()
    expect(body['investmentSize'] ?? null).toBeNull()
    for (const k of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(body, k), `internal key "${k}" leaked`).toBe(false)
    }
  })
})

describe('GET /companies/:id — co-investors from the synced join', () => {
  test('returns co-investor company names ordered by position', async () => {
    const userId = await insertTestUser()
    const companyId = await insertTestCompany({ userId, name: 'Amma ' + TEST_PREFIX })
    const seq = await insertTestCompany({ userId, name: 'Sequoia ' + TEST_PREFIX })
    const a16z = await insertTestCompany({ userId, name: 'a16z ' + TEST_PREFIX })
    // Out-of-order positions to prove ORDER BY position.
    await db.insert(schema.companyInvestors).values({
      id: TEST_PREFIX + 'ci-1', companyId, investorCompanyId: a16z,
      investorType: 'co_investor', position: 1, lamport: '1',
    })
    await db.insert(schema.companyInvestors).values({
      id: TEST_PREFIX + 'ci-2', companyId, investorCompanyId: seq,
      investorType: 'co_investor', position: 0, lamport: '1',
    })
    // A prior_investor must NOT appear in the co-investor list.
    await db.insert(schema.companyInvestors).values({
      id: TEST_PREFIX + 'ci-3', companyId, investorCompanyId: a16z,
      investorType: 'prior_investor', position: 0, lamport: '1',
    })
    cleanup.track(schema.companyInvestors, schema.companyInvestors.id, TEST_PREFIX + 'ci-1')
    cleanup.track(schema.companyInvestors, schema.companyInvestors.id, TEST_PREFIX + 'ci-2')
    cleanup.track(schema.companyInvestors, schema.companyInvestors.id, TEST_PREFIX + 'ci-3')

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${companyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { coInvestors: string[] | null }
    expect(body.coInvestors).toEqual(['Sequoia ' + TEST_PREFIX, 'a16z ' + TEST_PREFIX])
  })

  test('co-investors is null when there are none', async () => {
    const userId = await insertTestUser()
    const companyId = await insertTestCompany({ userId, name: 'NoInv ' + TEST_PREFIX })
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${companyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as { coInvestors: string[] | null }
    expect(body.coInvestors).toBeNull()
  })
})
