import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// /search fan-out tests.

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

const TEST_PREFIX = `test-sr-${Date.now().toString(36)}-`
// Use a search term unique enough not to collide with seeded test data.
const NEEDLE = `dragonfruit${Date.now().toString(36)}`

const createdUserIds: string[] = []
const createdCompanyIds: string[] = []
const createdContactIds: string[] = []
const createdMeetingIds: string[] = []
const createdNoteIds: string[] = []

afterAll(async () => {
  if (createdNoteIds.length > 0) {
    await db.delete(schema.notes).where(inArray(schema.notes.id, createdNoteIds))
  }
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

async function insertUser(): Promise<string> {
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
  email?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId: opts.userId,
    fullName: opts.fullName,
    normalizedName: opts.fullName.toLowerCase(),
    email: opts.email ?? null,
  })
  createdContactIds.push(id)
  return id
}

async function insertMeeting(userId: string, title: string): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title,
    date: new Date(),
    durationSeconds: 1800,
    status: 'completed',
  })
  createdMeetingIds.push(id)
  return id
}

async function insertNote(opts: {
  userId: string
  title?: string
  content: string
}): Promise<string> {
  const id = TEST_PREFIX + 'nt-' + createId().slice(0, 8)
  await db.insert(schema.notes).values({
    id,
    userId: opts.userId,
    title: opts.title ?? null,
    content: opts.content,
  })
  createdNoteIds.push(id)
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

describe('GET /search', () => {
  test('fans out across all four entity types', async () => {
    const userId = await insertUser()

    const coId = await insertCompany(userId, `${NEEDLE} Holdings`)
    const ctId = await insertContact({
      userId,
      fullName: `${NEEDLE} Founder`,
    })
    const mtgId = await insertMeeting(userId, `${NEEDLE} Discovery`)
    const ntId = await insertNote({
      userId,
      content: `notes about ${NEEDLE} traction`,
    })

    // Noise rows that shouldn't match.
    await insertCompany(userId, 'Unrelated Co')
    await insertContact({ userId, fullName: 'Someone Else' })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=${encodeURIComponent(NEEDLE)}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      query: string
      companies: { items: Array<{ id: string }>; total: number }
      contacts: { items: Array<{ id: string }>; total: number }
      meetings: { items: Array<{ id: string }>; total: number }
      notes: { items: Array<{ id: string }>; total: number }
    }

    expect(body.query).toBe(NEEDLE)
    expect(body.companies.items.map((c) => c.id)).toEqual([coId])
    expect(body.contacts.items.map((c) => c.id)).toEqual([ctId])
    expect(body.meetings.items.map((m) => m.id)).toEqual([mtgId])
    expect(body.notes.items.map((n) => n.id)).toEqual([ntId])

    // Counts should match items count when below limit.
    expect(body.companies.total).toBe(1)
    expect(body.contacts.total).toBe(1)
    expect(body.meetings.total).toBe(1)
    expect(body.notes.total).toBe(1)
  })

  test('contact search matches via email as well as name', async () => {
    const userId = await insertUser()
    const byEmailId = await insertContact({
      userId,
      fullName: 'Plain Name ' + TEST_PREFIX,
      email: `${NEEDLE}-email@example.com`,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=${encodeURIComponent(NEEDLE)}-email`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as { contacts: { items: Array<{ id: string }> } }
    expect(body.contacts.items.map((c) => c.id)).toContain(byEmailId)
  })

  test('per-type limit caps results but total reflects true match count', async () => {
    const userId = await insertUser()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      ids.push(await insertCompany(userId, `${NEEDLE} Co ${i}`))
    }

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=${encodeURIComponent(NEEDLE)}&limit=3`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    const body = res.json() as {
      companies: { items: Array<{ id: string }>; total: number }
    }
    expect(body.companies.items.length).toBe(3)
    expect(body.companies.total).toBe(7)
  })

  test('user isolation: only caller results returned', async () => {
    const userA = await insertUser()
    const userB = await insertUser()
    const coA = await insertCompany(userA, `${NEEDLE} ACo`)
    const coB = await insertCompany(userB, `${NEEDLE} BCo`)

    const jwtA = await mintJwt(userA)
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=${encodeURIComponent(NEEDLE)}`,
      headers: { authorization: `Bearer ${jwtA}` },
    })

    const body = res.json() as { companies: { items: Array<{ id: string }> } }
    const ids = body.companies.items.map((c) => c.id)
    expect(ids).toContain(coA)
    expect(ids).not.toContain(coB)
  })

  test('400 when q is missing', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: '/search',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(400)
  })

  test('401 with no auth header', async () => {
    const res = await app.inject({ method: 'GET', url: `/search?q=${NEEDLE}` })
    expect(res.statusCode).toBe(401)
  })
})
