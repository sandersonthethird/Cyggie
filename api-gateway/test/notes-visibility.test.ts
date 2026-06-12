import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// =============================================================================
// Firm-visibility for notes — the security boundary in
// api-gateway/src/notes/visibility.ts.
//
// Setup: firm1 has userA + userB; firm2 has userC. userA owns three notes:
//   aShared   — tagged to a company, not private  → firm-visible
//   aPrivate  — tagged, is_private = true          → owner-only
//   aUntagged — no company/contact                 → owner-only (untagged)
//
// Asserted:
//   • owner (userA) sees all three
//   • teammate (userB) sees aShared only — NOT aPrivate, NOT aUntagged
//   • cross-firm (userC) sees none, even with a guessed note id → 404
//   • author fields populated on a teammate's note
//   • FTS (?q=) respects visibility
//   • list `total` reflects exactly the visible set (each firm is unique to
//     this file, so the counts are deterministic)
//   • PATCH by a teammate → 404 (read-only; owner-scoped writes)
// =============================================================================

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const { noteVisibilityFilter } = await import('../src/notes/visibility')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-nv-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function insertFirm(): Promise<string> {
  const id = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id, name: id, slug: id })
  cleanup.track(schema.firms, schema.firms.id, id)
  return id
}

async function insertUser(firmId: string, displayName: string): Promise<string> {
  const id = TEST_PREFIX + 'u-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName,
    firmId,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

async function insertCompany(userId: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  const name = 'Co ' + id
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

async function insertNote(opts: {
  userId: string
  content: string
  companyId?: string | null
  isPrivate?: boolean
}): Promise<string> {
  const id = TEST_PREFIX + 'nt-' + createId().slice(0, 8)
  await db.insert(schema.notes).values({
    id,
    userId: opts.userId,
    content: opts.content,
    companyId: opts.companyId ?? null,
    isPrivate: opts.isPrivate ?? false,
    createdByUserId: opts.userId,
  })
  cleanup.track(schema.notes, schema.notes.id, id)
  return id
}

async function mintJwt(userId: string, firmId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: TEST_PREFIX + 'dev',
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
}

interface ListBody {
  notes: Array<{ id: string; isPrivate: boolean; authorUserId: string; authorName: string | null }>
  total: number
}

// Shared fixture for the whole file.
const firm1 = await insertFirm()
const firm2 = await insertFirm()
const userA = await insertUser(firm1, 'Alice')
const userB = await insertUser(firm1, 'Bob')
const userC = await insertUser(firm2, 'Carol')
const companyId = await insertCompany(userA)

const aShared = await insertNote({ userId: userA, content: 'shared deal memo', companyId })
const aPrivate = await insertNote({ userId: userA, content: 'gutcheck secret', companyId, isPrivate: true })
const aUntagged = await insertNote({ userId: userA, content: 'loose untagged thought' })

const jwtA = await mintJwt(userA, firm1)
const jwtB = await mintJwt(userB, firm1)
const jwtC = await mintJwt(userC, firm2)

async function list(jwt: string): Promise<ListBody> {
  const res = await app.inject({
    method: 'GET',
    url: '/notes?limit=100',
    headers: { authorization: `Bearer ${jwt}` },
  })
  expect(res.statusCode).toBe(200)
  return res.json() as ListBody
}

describe('GET /notes — firm visibility', () => {
  test('owner sees all of their own notes (shared, private, untagged)', async () => {
    const body = await list(jwtA)
    const ids = body.notes.map((n) => n.id)
    expect(ids).toContain(aShared)
    expect(ids).toContain(aPrivate)
    expect(ids).toContain(aUntagged)
    // firm1 is unique to this file → total is exactly userA's 3 notes.
    expect(body.total).toBe(3)
  })

  test('teammate sees the shared note only — not private, not untagged', async () => {
    const body = await list(jwtB)
    const ids = body.notes.map((n) => n.id)
    expect(ids).toContain(aShared)
    expect(ids).not.toContain(aPrivate)
    expect(ids).not.toContain(aUntagged)
    // total reflects exactly the visible set for the teammate.
    expect(body.total).toBe(1)
  })

  test("teammate's view carries author attribution", async () => {
    const body = await list(jwtB)
    const row = body.notes.find((n) => n.id === aShared)
    expect(row?.authorUserId).toBe(userA)
    expect(row?.authorName).toBe('Alice')
    expect(row?.isPrivate).toBe(false)
  })

  test('cross-firm user sees none of the firm1 notes', async () => {
    const body = await list(jwtC)
    const ids = body.notes.map((n) => n.id)
    expect(ids).not.toContain(aShared)
    expect(ids).not.toContain(aPrivate)
    expect(ids).not.toContain(aUntagged)
    expect(body.total).toBe(0)
  })

  test('FTS (?q=) respects visibility — teammate cannot find a private note', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/notes?q=gutcheck&limit=100',
      headers: { authorization: `Bearer ${jwtB}` },
    })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as ListBody).notes.map((n) => n.id)
    expect(ids).not.toContain(aPrivate)
    // Owner CAN find it.
    const ownerRes = await app.inject({
      method: 'GET',
      url: '/notes?q=gutcheck&limit=100',
      headers: { authorization: `Bearer ${jwtA}` },
    })
    expect((ownerRes.json() as ListBody).notes.map((n) => n.id)).toContain(aPrivate)
  })
})

describe('GET /notes/:id — firm visibility', () => {
  async function get(jwt: string, id: string): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    return res.statusCode
  }

  test('teammate can read a shared note', async () => {
    expect(await get(jwtB, aShared)).toBe(200)
  })

  test("teammate gets 404 on the owner's private note (no existence disclosure)", async () => {
    expect(await get(jwtB, aPrivate)).toBe(404)
  })

  test('teammate gets 404 on the owner’s untagged note', async () => {
    expect(await get(jwtB, aUntagged)).toBe(404)
  })

  test('cross-firm user gets 404 even for the shared note', async () => {
    expect(await get(jwtC, aShared)).toBe(404)
  })
})

// Decision 3A — exercise the predicate directly (not just through the route)
// so a regression in noteVisibilityFilter is pinpointed at the boundary it
// guards. Seed is the file fixture; the query mirrors the route's join.
describe('noteVisibilityFilter predicate', () => {
  const seeded = () => [aShared, aPrivate, aUntagged]

  async function visibleIds(viewer: { sub: string; firm_id: string }): Promise<string[]> {
    const rows = await db
      .select({ id: schema.notes.id })
      .from(schema.notes)
      .innerJoin(schema.users, eq(schema.users.id, schema.notes.userId))
      .where(and(noteVisibilityFilter(viewer), inArray(schema.notes.id, seeded())))
    return rows.map((r) => r.id).sort()
  }

  test('owner predicate returns all three', async () => {
    expect(await visibleIds({ sub: userA, firm_id: firm1 })).toEqual([aShared, aPrivate, aUntagged].sort())
  })

  test('teammate predicate returns exactly the shared note', async () => {
    expect(await visibleIds({ sub: userB, firm_id: firm1 })).toEqual([aShared])
  })

  test('cross-firm predicate returns nothing', async () => {
    expect(await visibleIds({ sub: userC, firm_id: firm2 })).toEqual([])
  })
})

describe('PATCH /notes/:id — teammates are read-only', () => {
  test('teammate PATCH on a shared note → 404 (owner-scoped writes)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${aShared}`,
      headers: { authorization: `Bearer ${jwtB}`, 'content-type': 'application/json' },
      payload: { content: 'teammate tampering', lamport: '999' },
    })
    expect(res.statusCode).toBe(404)
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, aShared) })
    expect(row?.content).toBe('shared deal memo')
  })
})
