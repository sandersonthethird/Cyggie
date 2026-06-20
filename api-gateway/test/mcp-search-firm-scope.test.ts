import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// =============================================================================
// Firm-scope parity for cyggie_search's non-note buckets (companies, contacts,
// meetings) — the follow-up to the firm-brain notes workstream. Previously the
// MCP search tool scoped these three to user_id = me even after REST WS1 made
// the REST /search route firm-scoped. Now all four buckets match REST:
//   companies  — fully firm-shared (no is_private)
//   contacts   — firm-shared unless is_private
//   meetings   — firm-shared unless is_private
//   null firm  — owner-only fallback
//
// Setup: firm1 has userA (owner) + userB (teammate); firm2 has userC. userA
// owns a NEEDLE-named company, a shared + a private contact, and a shared + a
// private meeting. Asserted via cyggieSearch's markdown (ids embedded in it).
// =============================================================================

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { cyggieSearch } = await import('../src/mcp/tools/search')
const { isToolError } = await import('../src/shared/error-envelope')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-msfs-${Date.now().toString(36)}-`
// Unique ilike needle shared across the company/contact/meeting names so one
// query returns all three buckets without colliding with seeded data.
const NEEDLE = `zphirmscope${Date.now().toString(36)}`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
})

async function insertFirm(): Promise<string> {
  const id = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id, name: id, slug: id })
  cleanup.track(schema.firms, schema.firms.id, id)
  return id
}

async function insertUser(firmId: string): Promise<string> {
  const id = TEST_PREFIX + 'u-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName: id,
    firmId,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

async function insertCompany(opts: { userId: string; firmId: string; name: string }): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId: opts.userId,
    firmId: opts.firmId,
    canonicalName: opts.name,
    normalizedName: opts.name.toLowerCase() + ' ' + id,
    status: 'active',
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

async function insertContact(opts: {
  userId: string
  firmId: string
  fullName: string
  isPrivate?: boolean
}): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId: opts.userId,
    firmId: opts.firmId,
    fullName: opts.fullName,
    normalizedName: opts.fullName.toLowerCase(),
    isPrivate: opts.isPrivate ?? false,
  })
  cleanup.track(schema.contacts, schema.contacts.id, id)
  return id
}

async function insertMeeting(opts: {
  userId: string
  firmId: string
  title: string
  isPrivate?: boolean
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    firmId: opts.firmId,
    title: opts.title,
    date: new Date('2026-05-20T10:00:00Z'),
    durationSeconds: 1800,
    status: 'completed',
    isPrivate: opts.isPrivate ?? false,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

function text(r: Awaited<ReturnType<typeof cyggieSearch>>): string {
  if (isToolError(r)) throw new Error(`expected ok, got error: ${r.error.code}`)
  return r.result
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const firm1 = await insertFirm()
const firm2 = await insertFirm()
const userA = await insertUser(firm1) // owner
const userB = await insertUser(firm1) // teammate
const userC = await insertUser(firm2) // other firm

const companyId = await insertCompany({ userId: userA, firmId: firm1, name: `${NEEDLE} SharedCo` })
const sharedContactId = await insertContact({
  userId: userA,
  firmId: firm1,
  fullName: `${NEEDLE} SharedContact`,
})
const privateContactId = await insertContact({
  userId: userA,
  firmId: firm1,
  fullName: `${NEEDLE} PrivateContact`,
  isPrivate: true,
})
const sharedMeetingId = await insertMeeting({
  userId: userA,
  firmId: firm1,
  title: `${NEEDLE} SharedMeeting`,
})
const privateMeetingId = await insertMeeting({
  userId: userA,
  firmId: firm1,
  title: `${NEEDLE} PrivateMeeting`,
  isPrivate: true,
})

describe('cyggie_search — firm scope for companies / contacts / meetings', () => {
  test('teammate sees the firm company (companies are fully firm-shared)', async () => {
    const r = text(await cyggieSearch({ db, userId: userB, firmId: firm1, query: NEEDLE }))
    expect(r).toContain(companyId)
  })

  test('teammate sees a shared contact/meeting but NOT a private one (leak guard)', async () => {
    const r = text(await cyggieSearch({ db, userId: userB, firmId: firm1, query: NEEDLE }))
    expect(r).toContain(sharedContactId)
    expect(r).toContain(sharedMeetingId)
    expect(r).not.toContain(privateContactId)
    expect(r).not.toContain(privateMeetingId)
  })

  test('cross-firm caller sees none of the firm1 rows', async () => {
    const r = await cyggieSearch({ db, userId: userC, firmId: firm2, query: NEEDLE })
    const body = isToolError(r) ? '' : r.result
    for (const id of [companyId, sharedContactId, sharedMeetingId, privateContactId, privateMeetingId]) {
      expect(body).not.toContain(id)
    }
  })

  test('owner sees their own rows including the private ones', async () => {
    const r = text(await cyggieSearch({ db, userId: userA, firmId: firm1, query: NEEDLE }))
    expect(r).toContain(privateContactId)
    expect(r).toContain(privateMeetingId)
  })

  test('firmId = null falls back to owner-only', async () => {
    // Owner with no firm still sees own rows…
    const own = text(await cyggieSearch({ db, userId: userA, firmId: null, query: NEEDLE }))
    expect(own).toContain(companyId)
    // …but a teammate with no firm sees none of userA's rows.
    const teammate = await cyggieSearch({ db, userId: userB, firmId: null, query: NEEDLE })
    const body = isToolError(teammate) ? '' : teammate.result
    expect(body).not.toContain(companyId)
    expect(body).not.toContain(sharedContactId)
    expect(body).not.toContain(sharedMeetingId)
  })
})
