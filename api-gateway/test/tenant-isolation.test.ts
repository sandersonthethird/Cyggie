// Slice F (10A) — the cross-firm tenant-isolation regression gate. ONE shared
// two-firm fixture (A, B) with overlapping company/contact/meeting names, then a
// DISTINCT assertion per read path so a failure pinpoints the leaking surface:
//
//   1. Sync pull          — B's /sync/pull returns only firm-B rows
//   2. MCP structured search — runCyggieSearch as B sees no firm-A entities
//   3. execute_sql RLS    — readonly role + app.firm_id=B sees only B (CI-only:
//                           needs NEON_READONLY_URL; skipped locally with a log)
//   4. Enrichment         — a firm-scoped sweep touches only its firm's meetings
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import { makeDbCleanup } from './_helpers/db-cleanup'

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const { runCyggieSearch } = await import('../src/mcp/tools/search')
const { runEnrichmentSweep } = await import('../src/services/enrichment/enrichment-sweep')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)
const cleanup = makeDbCleanup(db)
const P = `test-iso-${Date.now().toString(36)}-`

// Overlapping name across both firms — the whole point is that scoping, not
// name-uniqueness, is what isolates them.
const SHARED = `${P}Globex`
const HOUR = 60 * 60 * 1000

interface FirmFixture {
  firmId: string
  userId: string
  companyId: string
  contactId: string
  meetingId: string
  token: string
}

async function seedFirm(tag: string, attendeeDomain: string): Promise<FirmFixture> {
  const firmId = `${P}firm-${tag}`
  const userId = `${P}user-${tag}`
  await db.insert(schema.firms).values({ id: firmId, name: `Firm ${tag}`, slug: firmId })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  await db
    .insert(schema.users)
    .values({ id: userId, googleSub: 'sub-' + userId, email: `${userId}@example.com`, displayName: userId, firmId })
  cleanup.track(schema.users, schema.users.id, userId)
  cleanup.track(schema.sessions, schema.sessions.userId, userId)

  // lamport > 0 so the rows are visible to /sync/pull?since=0 (pull filters on lamport > since).
  const companyId = `${P}co-${tag}`
  await db.insert(schema.orgCompanies).values({
    id: companyId,
    userId,
    firmId,
    canonicalName: SHARED,
    normalizedName: SHARED.toLowerCase(),
    primaryDomain: `${tag}.example`,
    createdByUserId: userId,
    lamport: '5',
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)

  const contactId = `${P}ct-${tag}`
  await db.insert(schema.contacts).values({
    id: contactId,
    userId,
    firmId,
    fullName: SHARED,
    normalizedName: SHARED.toLowerCase(),
    createdByUserId: userId,
    lamport: '5',
  })
  cleanup.track(schema.contacts, schema.contacts.id, contactId)

  const meetingId = `${P}mtg-${tag}`
  await db.insert(schema.meetings).values({
    id: meetingId,
    userId,
    firmId,
    title: SHARED,
    date: new Date('2026-06-27T10:00:00Z'),
    status: 'scheduled',
    calendarEventId: 'cal-' + meetingId,
    attendeeEmails: [`attendee@${attendeeDomain}`],
    createdAt: new Date(Date.now() - HOUR),
    createdByUserId: userId,
    lamport: '5',
  })
  cleanup.track(schema.meetings, schema.meetings.id, meetingId)

  const token = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: `${P}sid-${tag}`,
    device: `${P}dev-${tag}`,
    scope: ['user'],
    firm_id: firmId,
    role: 'admin',
  })
  return { firmId, userId, companyId, contactId, meetingId, token }
}

let A: FirmFixture
let B: FirmFixture

beforeAll(async () => {
  A = await seedFirm('a', `${P}globex-a.com`)
  B = await seedFirm('b', `${P}globex-b.com`)
})

afterAll(async () => {
  // Enrichment may create org_companies/contacts (from attendee domains) under
  // either firm — sweep them before the fixture rows so FK order holds.
  for (const f of [A, B]) {
    for (const c of await db.select({ id: schema.orgCompanies.id }).from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, f.firmId))) {
      cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
    }
    for (const c of await db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.firmId, f.firmId))) {
      cleanup.track(schema.contacts, schema.contacts.id, c.id)
    }
  }
  await cleanup.cleanup()
  await app.close()
})

describe('cross-firm tenant isolation (Slice F gate)', () => {
  test('1. sync pull — firm B receives only firm-B rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=0',
      headers: { authorization: `Bearer ${B.token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      orgCompanies: Array<{ id: string }>
      contacts: Array<{ id: string }>
      meetings: Array<{ id: string }>
    }
    const ids = [
      ...body.orgCompanies.map((r) => r.id),
      ...body.contacts.map((r) => r.id),
      ...body.meetings.map((r) => r.id),
    ]
    // None of firm A's rows leak into B's pull…
    expect(ids).not.toContain(A.companyId)
    expect(ids).not.toContain(A.contactId)
    expect(ids).not.toContain(A.meetingId)
    // …and B's own rows are present.
    expect(body.orgCompanies.map((r) => r.id)).toContain(B.companyId)
  })

  test('2. MCP search — firm B sees no firm-A entities for the shared name', async () => {
    const results = await runCyggieSearch({ db, userId: B.userId, firmId: B.firmId, query: SHARED, limit: 10 })
    const ids = [
      ...results.companies.items.map((i) => i.id),
      ...results.contacts.items.map((i) => i.id),
      ...results.meetings.items.map((i) => i.id),
    ]
    expect(ids).toContain(B.companyId) // B finds its own
    expect(ids).not.toContain(A.companyId)
    expect(ids).not.toContain(A.contactId)
    expect(ids).not.toContain(A.meetingId)
  })

  // RLS is enforced by the cyggie_readonly Postgres role (NOBYPASSRLS) + the
  // policies in migration 0043. Without NEON_READONLY_URL there's no role to
  // exercise locally, so this runs in CI only — logged, never silently skipped.
  const hasReadonly = Boolean(process.env['NEON_READONLY_URL'])
  test.skipIf(!hasReadonly)(
    '3. execute_sql RLS — readonly role with app.firm_id=B sees only firm B (+ null safe-default)',
    async () => {
      const { getReadOnlyPool } = await import('../src/db/readonly-pool')
      const pool = getReadOnlyPool(env)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [B.userId])
        await client.query(`SELECT set_config('app.firm_id', $1, true)`, [B.firmId])
        const shared = await client.query('SELECT id, firm_id FROM contacts WHERE full_name = $1', [SHARED])
        expect(shared.rows.every((r) => r.firm_id === B.firmId)).toBe(true)
        expect(shared.rows.some((r) => r.id === A.contactId)).toBe(false)
        // Null firm safe-default → empty string → only the caller's own rows.
        await client.query(`SELECT set_config('app.firm_id', $1, true)`, [''])
        const ownOnly = await client.query('SELECT id, firm_id FROM contacts WHERE full_name = $1', [SHARED])
        expect(ownOnly.rows.every((r) => r.firm_id === B.firmId)).toBe(true)
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    },
  )
  if (!hasReadonly) {
    // eslint-disable-next-line no-console
    console.warn('[tenant-isolation] case 3 (execute_sql RLS) skipped — NEON_READONLY_URL unset (CI-only)')
  }

  test('4. enrichment — a firm-scoped sweep touches only its own firm’s meetings', async () => {
    const seenFirmIds: Array<string | null> = []
    const llmFor = async (_ownerUserId: string, firmId: string | null): Promise<LLMProvider | null> => {
      seenFirmIds.push(firmId)
      return null // skip name resolution; we only assert scoping here
    }
    await runEnrichmentSweep(db, { firmId: B.firmId, minAgeMs: 30 * 60 * 1000, llmFor })

    const [bRow] = await db.select({ enrichedAt: schema.meetings.enrichedAt }).from(schema.meetings).where(eq(schema.meetings.id, B.meetingId))
    const [aRow] = await db.select({ enrichedAt: schema.meetings.enrichedAt }).from(schema.meetings).where(eq(schema.meetings.id, A.meetingId))
    expect(bRow?.enrichedAt).not.toBeNull() // B's meeting was enriched
    expect(aRow?.enrichedAt).toBeNull() // A's meeting was never touched
    // Any LLM resolution that did fire was scoped to firm B, never firm A.
    expect(seenFirmIds.every((f) => f === B.firmId)).toBe(true)
  })
})
