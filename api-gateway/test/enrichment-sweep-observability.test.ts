import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Slice 3 — sweep observability: SweepResult counts + dead-letter + Sentry on hard fail.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

// Mock Sentry so we can assert the background path captures hard failures (it isn't
// auto-captured — it runs off-request).
vi.mock('@sentry/node', () => ({ captureException: vi.fn(), init: vi.fn(), addBreadcrumb: vi.fn(), flush: vi.fn(async () => true) }))

const Sentry = await import('@sentry/node')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { runEnrichmentSweep } = await import('../src/services/enrichment/enrichment-sweep')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)
const TEST_PREFIX = `test-obs-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
const HOUR = 60 * 60 * 1000
const silent = { info: () => {}, error: () => {} }

let FIRM_ID = ''
let USER_ID = ''
let tag = ''
const at = (local: string) => `${local}-${tag}@acme.com`

const stubLlm = (name = 'Acme Inc'): LLMProvider => ({
  name: 'stub', isAvailable: async () => true, generateSummary: async () => name, streamWithThinking: async () => name,
})

async function insertMeeting(opts: { attendeeEmails: string[]; enrichAttempts?: number | null }): Promise<string> {
  const id = TEST_PREFIX + 'm-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id, userId: USER_ID, firmId: FIRM_ID, title: 'T', date: new Date('2026-06-27T10:00:00Z'),
    status: 'scheduled', calendarEventId: 'cal-' + id, attendeeEmails: opts.attendeeEmails,
    enrichAttempts: opts.enrichAttempts ?? null, createdAt: new Date(Date.now() - HOUR), createdByUserId: USER_ID,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}
async function insertFirmUser(): Promise<{ firmId: string; userId: string }> {
  const firmId = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id: firmId, name: 'Obs', slug: firmId })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  const userId = TEST_PREFIX + 'u-' + createId().slice(0, 8)
  await db.insert(schema.users).values({ id: userId, googleSub: 'sub-' + userId, email: `${userId}@x.com`, displayName: userId, firmId })
  cleanup.track(schema.users, schema.users.id, userId)
  return { firmId, userId }
}
async function trackFirmCrm(): Promise<void> {
  for (const c of await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))) cleanup.track(schema.contacts, schema.contacts.id, c.id)
  for (const c of await db.select().from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))) cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
}

beforeEach(async () => {
  vi.mocked(Sentry.captureException).mockClear()
  const fu = await insertFirmUser()
  FIRM_ID = fu.firmId
  USER_ID = fu.userId
  tag = createId().slice(0, 8)
})
afterAll(async () => { await cleanup.cleanup() })

describe('enrichment sweep — observability (Slice 3)', () => {
  test('SweepResult carries enriched counts + durationMs', async () => {
    await insertMeeting({ attendeeEmails: [at('jane')] })
    const r = await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent, llmFor: async () => stubLlm('Acme Incorporated') })

    expect(r.processed).toBe(1)
    expect(r.enriched).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.contactsCreated).toBe(1)
    expect(r.companiesCreated).toBe(1)
    expect(r.linksCreated).toBe(1)
    expect(r.namesUpdated).toBe(1) // created "Acme" → renamed "Acme Incorporated"
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect(Sentry.captureException).not.toHaveBeenCalled()
    await trackFirmCrm()
  })

  test('a meeting that crosses maxAttempts is dead-lettered + Sentry-captured', async () => {
    // Non-destructive failure injection: a contact with the meeting's attendee email
    // already exists in ANOTHER firm. contacts.email is globally unique, so this firm's
    // sweep tries to CREATE that contact and hits the unique constraint → applyWritePlan
    // throws. Pre-set attempts=2 so this single failure crosses maxAttempts=3.
    const other = await insertFirmUser()
    await db.insert(schema.contacts).values({
      id: TEST_PREFIX + 'blocker-' + createId().slice(0, 8), userId: other.userId, firmId: other.firmId,
      fullName: 'Blocker', normalizedName: 'blocker', email: at('jane'), lamport: '1', createdByUserId: other.userId,
    })

    const meetingId = await insertMeeting({ attendeeEmails: [at('jane')], enrichAttempts: 2 })
    const r = await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, maxAttempts: 3, log: silent })

    expect(r.failed).toBe(1)
    expect(r.deadLettered).toBe(1)
    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    expect(vi.mocked(Sentry.captureException).mock.calls[0]?.[1]).toMatchObject({ tags: { source: 'enrichment-sweep' } })
    // The meeting stayed un-enriched and its attempts hit the cap.
    const m = await db.select({ e: schema.meetings.enrichedAt, a: schema.meetings.enrichAttempts }).from(schema.meetings).where(eq(schema.meetings.id, meetingId))
    expect(m[0]?.e).toBeNull()
    expect(m[0]?.a).toBe(3)
    // Clean up the blocker + any partial rows.
    for (const c of await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, other.firmId))) cleanup.track(schema.contacts, schema.contacts.id, c.id)
    await trackFirmCrm()
  })

  test('a failure BELOW maxAttempts logs but does NOT Sentry (low noise)', async () => {
    const other = await insertFirmUser()
    await db.insert(schema.contacts).values({
      id: TEST_PREFIX + 'blocker2-' + createId().slice(0, 8), userId: other.userId, firmId: other.firmId,
      fullName: 'Blocker', normalizedName: 'blocker', email: at('bob'), lamport: '1', createdByUserId: other.userId,
    })
    await insertMeeting({ attendeeEmails: [at('bob')], enrichAttempts: 0 }) // first failure → attempts 1 < 3
    const r = await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, maxAttempts: 3, log: silent })

    expect(r.failed).toBe(1)
    expect(r.deadLettered).toBe(0)
    expect(Sentry.captureException).not.toHaveBeenCalled()
    for (const c of await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, other.firmId))) cleanup.track(schema.contacts, schema.contacts.id, c.id)
    await trackFirmCrm()
  })
})
