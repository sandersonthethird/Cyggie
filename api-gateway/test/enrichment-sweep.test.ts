import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// enrichment-sweep against the embedded test Postgres. Drives runEnrichmentSweep
// directly (no flag/throttle) with deterministic ages.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { runEnrichmentSweep } = await import('../src/services/enrichment/enrichment-sweep')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)
const TEST_PREFIX = `test-sweep-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
const HOUR = 60 * 60 * 1000
const silent = { info: () => {}, error: () => {} }

let FIRM_ID = ''
let USER_ID = ''
let tag = ''
const at = (local: string) => `${local}-${tag}@acme.com`

async function insertMeeting(opts: {
  attendeeEmails?: string[]
  createdAt?: Date
  calendarEventId?: string | null
  enrichedAt?: Date | null
  enrichAttempts?: number | null
}): Promise<string> {
  const id = TEST_PREFIX + 'm-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: USER_ID,
    firmId: FIRM_ID,
    title: 'Test',
    date: new Date('2026-06-27T10:00:00Z'),
    status: 'scheduled',
    calendarEventId: opts.calendarEventId === undefined ? 'cal-' + id : opts.calendarEventId,
    attendeeEmails: opts.attendeeEmails ?? null,
    enrichedAt: opts.enrichedAt ?? null,
    enrichAttempts: opts.enrichAttempts ?? null,
    createdAt: opts.createdAt ?? new Date(),
    createdByUserId: USER_ID,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function enrichedAtOf(meetingId: string): Promise<Date | null> {
  const r = await db.select({ e: schema.meetings.enrichedAt }).from(schema.meetings).where(eq(schema.meetings.id, meetingId))
  return r[0]?.e ?? null
}
async function contactExists(email: string): Promise<boolean> {
  const r = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.firmId, FIRM_ID), eq(schema.contacts.email, email)))
  for (const c of r) cleanup.track(schema.contacts, schema.contacts.id, c.id)
  return r.length > 0
}
async function trackFirmCrm(): Promise<void> {
  for (const c of await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))) cleanup.track(schema.contacts, schema.contacts.id, c.id)
  for (const c of await db.select().from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))) cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
}

beforeEach(async () => {
  FIRM_ID = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id: FIRM_ID, name: 'Sweep Firm', slug: FIRM_ID })
  cleanup.track(schema.firms, schema.firms.id, FIRM_ID)
  tag = createId().slice(0, 8)
  USER_ID = TEST_PREFIX + 'u-' + createId().slice(0, 8)
  await db.insert(schema.users).values({ id: USER_ID, googleSub: 'sub-' + USER_ID, email: at('owner'), displayName: USER_ID, firmId: FIRM_ID })
  cleanup.track(schema.users, schema.users.id, USER_ID)
})
afterAll(async () => {
  await cleanup.cleanup()
})

describe('runEnrichmentSweep', () => {
  test('enriches an eligible offline meeting (old, un-enriched, calendar event)', async () => {
    const meetingId = await insertMeeting({ attendeeEmails: [at('jane')], createdAt: new Date(Date.now() - HOUR) })

    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent })

    expect(await enrichedAtOf(meetingId)).not.toBeNull()
    expect(await contactExists(at('jane'))).toBe(true)
    await trackFirmCrm()
  })

  test('skips a meeting that already has enriched_at (desktop did it)', async () => {
    const meetingId = await insertMeeting({
      attendeeEmails: [at('skip')],
      createdAt: new Date(Date.now() - HOUR),
      enrichedAt: new Date(Date.now() - HOUR),
    })

    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent })

    // No contact created for its attendee; enriched_at untouched (still in the past).
    expect(await contactExists(at('skip'))).toBe(false)
    expect(await enrichedAtOf(meetingId)).not.toBeNull()
  })

  test('skips a too-recent meeting (inside the desktop window)', async () => {
    const meetingId = await insertMeeting({ attendeeEmails: [at('fresh')], createdAt: new Date() })

    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, log: silent })

    expect(await enrichedAtOf(meetingId)).toBeNull()
    expect(await contactExists(at('fresh'))).toBe(false)
  })

  test('skips a dead-lettered meeting (enrich_attempts >= max)', async () => {
    const meetingId = await insertMeeting({
      attendeeEmails: [at('dead')],
      createdAt: new Date(Date.now() - HOUR),
      enrichAttempts: 3,
    })

    await runEnrichmentSweep(db, { firmId: FIRM_ID, minAgeMs: 30 * 60 * 1000, maxAttempts: 3, log: silent })

    expect(await enrichedAtOf(meetingId)).toBeNull()
    expect(await contactExists(at('dead'))).toBe(false)
  })
})
