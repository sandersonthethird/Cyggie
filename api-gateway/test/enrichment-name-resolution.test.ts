import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Slice 2 — gateway company-name resolution. Drives runEnrichmentSweep with a STUB
// LLMProvider (no real Anthropic). Created companies only; existing names untouched.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { runEnrichmentSweep } = await import('../src/services/enrichment/enrichment-sweep')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)
const TEST_PREFIX = `test-nameres-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
const HOUR = 60 * 60 * 1000
const silent = { info: () => {}, error: () => {} }

let FIRM_ID = ''
let USER_ID = ''
let tag = ''
const at = (local: string) => `${local}-${tag}@acme.com`

/** Stub LLMProvider: returns `name` (or throws); counts generateSummary calls. */
function stubLlm(opts: { name?: string; throws?: boolean; counter?: { n: number } }): LLMProvider {
  const reply = async (): Promise<string> => {
    if (opts.counter) opts.counter.n += 1
    if (opts.throws) throw new Error('llm down')
    return opts.name ?? 'Acme Inc'
  }
  return { name: 'stub', isAvailable: async () => true, generateSummary: reply, streamWithThinking: reply }
}

async function insertMeeting(attendeeEmails: string[], createdAt = new Date(Date.now() - HOUR)): Promise<string> {
  const id = TEST_PREFIX + 'm-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id, userId: USER_ID, firmId: FIRM_ID, title: 'T', date: new Date('2026-06-27T10:00:00Z'),
    status: 'scheduled', calendarEventId: 'cal-' + id, attendeeEmails, createdAt, createdByUserId: USER_ID,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}
async function insertCompany(canonicalName: string, normalizedName: string, primaryDomain: string | null): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({ id, userId: USER_ID, firmId: FIRM_ID, canonicalName, normalizedName, primaryDomain, lamport: '5', createdByUserId: USER_ID })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}
async function companyName(companyId: string): Promise<string | undefined> {
  const r = await db.select({ n: schema.orgCompanies.canonicalName }).from(schema.orgCompanies).where(eq(schema.orgCompanies.id, companyId))
  return r[0]?.n
}
async function createdCompanyByDomain(domain: string): Promise<{ id: string; name: string } | null> {
  const r = await db.select({ id: schema.orgCompanies.id, name: schema.orgCompanies.canonicalName })
    .from(schema.orgCompanies).where(and(eq(schema.orgCompanies.firmId, FIRM_ID), eq(schema.orgCompanies.primaryDomain, domain)))
  for (const c of r) cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
  return r[0] ?? null
}
async function trackFirmCrm(): Promise<void> {
  for (const c of await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))) cleanup.track(schema.contacts, schema.contacts.id, c.id)
  for (const c of await db.select().from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))) cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
}

beforeEach(async () => {
  FIRM_ID = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id: FIRM_ID, name: 'NR Firm', slug: FIRM_ID })
  cleanup.track(schema.firms, schema.firms.id, FIRM_ID)
  tag = createId().slice(0, 8)
  USER_ID = TEST_PREFIX + 'u-' + createId().slice(0, 8)
  await db.insert(schema.users).values({ id: USER_ID, googleSub: 'sub-' + USER_ID, email: at('owner'), displayName: USER_ID, firmId: FIRM_ID })
  cleanup.track(schema.users, schema.users.id, USER_ID)
})
afterAll(async () => { await cleanup.cleanup() })

describe('gateway name resolution (Slice 2)', () => {
  test('upgrades a CREATED company’s name to the LLM result', async () => {
    await insertMeeting([at('jane')]) // domain acme.com → creates company "Acme"
    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => stubLlm({ name: 'Acme Incorporated' }) })

    const co = await createdCompanyByDomain('acme.com')
    expect(co?.name).toBe('Acme Incorporated')
    await trackFirmCrm()
  })

  test('does NOT touch an EXISTING company’s name (created-only)', async () => {
    const existingId = await insertCompany('Acme', 'acme', 'acme.com') // meeting will MATCH this by domain
    await insertMeeting([at('jane')])
    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => stubLlm({ name: 'Acme Incorporated' }) })

    expect(await companyName(existingId)).toBe('Acme') // untouched
    await trackFirmCrm()
  })

  test('no Anthropic key (llmFor → null) → company keeps its heuristic seed name', async () => {
    await insertMeeting([at('jane')])
    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => null })

    const co = await createdCompanyByDomain('acme.com')
    expect(co?.name).toBe('Acme') // domainToTitleCase('acme.com')
    await trackFirmCrm()
  })

  test('LLM throws → degrades to heuristic, meeting still enriched', async () => {
    const meetingId = await insertMeeting([at('jane')])
    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => stubLlm({ throws: true }) })

    const co = await createdCompanyByDomain('acme.com')
    expect(co?.name).toBe('Acme') // heuristic fallback, no crash
    const m = await db.select({ e: schema.meetings.enrichedAt }).from(schema.meetings).where(eq(schema.meetings.id, meetingId))
    expect(m[0]?.e).not.toBeNull()
    await trackFirmCrm()
  })

  test('resolved name colliding with an existing company is skipped (enrichment intact)', async () => {
    await insertCompany('Acme Incorporated', 'acme incorporated', 'other.com') // occupies normalized "acme incorporated"
    await insertMeeting([at('jane')]) // creates "Acme" for acme.com; LLM resolves → colliding name
    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => stubLlm({ name: 'Acme Incorporated' }) })

    const co = await createdCompanyByDomain('acme.com')
    expect(co?.name).toBe('Acme') // rename skipped on the per-firm normalized_name collision
    // Enrichment itself stands: a contact + the meeting link exist.
    const contacts = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))
    expect(contacts.length).toBe(1)
    await trackFirmCrm()
  })

  test('per-pass domain cache — a shared domain hits the LLM once', async () => {
    await insertMeeting([at('jane')]) // acme.com
    await insertMeeting([at('bob')])  // acme.com (same domain, different attendee)
    const counter = { n: 0 }
    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => stubLlm({ name: 'Acme Inc', counter }) })

    expect(counter.n).toBe(1)
    await trackFirmCrm()
  })
})
