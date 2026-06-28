import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { buildCandidates, planMeetingEnrichment, type WritePlan } from '@cyggie/db/meeting-enrichment/plan'
import { deriveSeedCompanyNames } from '@cyggie/db/meeting-enrichment/helpers'
import { makeDbCleanup } from './_helpers/db-cleanup'

// PgEnrichmentStore against the embedded test Postgres (drizzle-kit push schema).
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { loadExistingState, applyWritePlan } = await import('../src/services/enrichment/pg-enrichment-store')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)
const TEST_PREFIX = `test-pges-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

let FIRM_ID = ''
let USER_ID = ''
let ownerEmail = '' // unique per test — users.email is globally unique
let tag = '' // unique per test — contacts.email is globally unique (cleanup is afterAll)
// Attendee email with a per-test-unique local part but a STABLE domain (so company
// derivation stays "Acme"); org_companies is per-firm-unique so the name can repeat.
const at = (local: string) => `${local}-${tag}@acme.com`

async function insertFirm(): Promise<string> {
  const id = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({ id, name: 'PGES Firm', slug: id })
  cleanup.track(schema.firms, schema.firms.id, id)
  return id
}
async function insertUser(firmId: string, email = ownerEmail): Promise<string> {
  const id = TEST_PREFIX + 'u-' + createId().slice(0, 8)
  await db.insert(schema.users).values({ id, googleSub: 'sub-' + id, email, displayName: id, firmId })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}
async function insertMeeting(opts: { attendees?: string[]; attendeeEmails?: string[] }): Promise<string> {
  const id = TEST_PREFIX + 'm-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: USER_ID,
    firmId: FIRM_ID,
    title: 'Test',
    date: new Date('2026-06-27T10:00:00Z'),
    status: 'scheduled',
    attendees: opts.attendees ?? null,
    attendeeEmails: opts.attendeeEmails ?? null,
    createdByUserId: USER_ID,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

/** Build candidates + seeds, load firm-scoped state, plan, apply — the sweep's pipeline. */
async function enrich(meetingId: string, attendees: string[], attendeeEmails: string[]) {
  const candidates = buildCandidates(attendees, attendeeEmails, ownerEmail)
  const seedNames = deriveSeedCompanyNames(attendees, attendeeEmails)
  const loaded = await loadExistingState(db, {
    firmId: FIRM_ID,
    candidateEmails: candidates.map((c) => c.email),
    seedNames,
    attendeeEmails,
    meetingId,
  })
  const plan = planMeetingEnrichment(loaded.state, { attendees, attendeeEmails }, {
    meetingId,
    ownerEmail: ownerEmail,
    isGroupEvent: false,
    companies: undefined,
  })
  return (await applyWritePlan(db, { userId: USER_ID, firmId: FIRM_ID, plan, loaded, attendeeEmails })).stats
}

async function countContacts(): Promise<number> {
  const rows = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))
  return rows.length
}
async function countCompanies(): Promise<number> {
  const rows = await db.select({ id: schema.orgCompanies.id }).from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))
  return rows.length
}

beforeEach(async () => {
  FIRM_ID = await insertFirm()
  tag = createId().slice(0, 8)
  ownerEmail = `owner-${tag}@redswan.com`
  USER_ID = await insertUser(FIRM_ID, ownerEmail)
})
afterAll(async () => {
  await cleanup.cleanup()
})

describe('PgEnrichmentStore.applyWritePlan', () => {
  test('creates contact + contact_email + company + aliases + link, firm-scoped & lamport-stamped', async () => {
    const meetingId = await insertMeeting({ attendeeEmails: [at('jane')] })
    const stats = await enrich(meetingId, [`Jane Doe <${at('jane')}>`], [at('jane')])

    expect(stats.contactsCreated).toBe(1)
    expect(stats.companiesCreated).toBe(1)
    expect(stats.linksCreated).toBe(1)

    const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))
    expect(contacts).toHaveLength(1)
    expect(contacts[0]!.email).toBe(at('jane'))
    expect(contacts[0]!.firmId).toBe(FIRM_ID)
    expect(contacts[0]!.lamport).not.toBe('0')
    cleanup.track(schema.contacts, schema.contacts.id, contacts[0]!.id)

    const emails = await db.select().from(schema.contactEmails).where(eq(schema.contactEmails.contactId, contacts[0]!.id))
    expect(emails.map((e) => e.email)).toContain(at('jane'))

    const companies = await db.select().from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))
    expect(companies).toHaveLength(1)
    expect(companies[0]!.canonicalName).toBe('Acme')
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companies[0]!.id)

    const aliases = await db.select().from(schema.orgCompanyAliases).where(eq(schema.orgCompanyAliases.companyId, companies[0]!.id))
    expect(aliases.some((a) => a.aliasType === 'name')).toBe(true)
    expect(aliases.some((a) => a.aliasType === 'domain')).toBe(true)

    const links = await db.select().from(schema.meetingCompanyLinks).where(eq(schema.meetingCompanyLinks.meetingId, meetingId))
    expect(links).toHaveLength(1)
    expect(links[0]!.companyId).toBe(companies[0]!.id)
  })

  test('idempotent — re-running produces no duplicate contacts or companies', async () => {
    const meetingId = await insertMeeting({ attendeeEmails: [at('jane')] })
    await enrich(meetingId, [`Jane Doe <${at('jane')}>`], [at('jane')])
    const c1 = await countContacts()
    const co1 = await countCompanies()

    await enrich(meetingId, [`Jane Doe <${at('jane')}>`], [at('jane')])
    expect(await countContacts()).toBe(c1)
    expect(await countCompanies()).toBe(co1)

    for (const c of await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))) {
      cleanup.track(schema.contacts, schema.contacts.id, c.id)
    }
    for (const c of await db.select().from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))) {
      cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
    }
  })

  test('skips creating a contact for a tombstoned email', async () => {
    await db.insert(schema.contactTombstones).values({ id: createId(), email: at('ghost'), userId: USER_ID })
    const meetingId = await insertMeeting({ attendeeEmails: [at('ghost'), at('real')] })
    await enrich(meetingId, [`Ghost <${at('ghost')}>`, `Real <${at('real')}>`], [at('ghost'), at('real')])

    const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.firmId, FIRM_ID))
    expect(contacts.map((c) => c.email).sort()).toEqual([at('real')])
    for (const c of contacts) cleanup.track(schema.contacts, schema.contacts.id, c.id)
    for (const c of await db.select().from(schema.orgCompanies).where(eq(schema.orgCompanies.firmId, FIRM_ID))) {
      cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c.id)
    }
  })

  test('atomic — a mid-apply FK failure rolls back the whole plan (no partial rows)', async () => {
    const meetingId = await insertMeeting({ attendeeEmails: [at('jane')] })
    // Hand-built plan: create a contact (succeeds) then a link to a non-existent
    // company (FK violation) — the transaction must roll the contact back too.
    const poisonPlan: WritePlan = {
      contactsToCreate: [{ email: at('jane'), fullName: 'Jane Doe', normalizedName: 'jane doe', firstName: 'Jane', lastName: 'Doe' }],
      emailsToAdd: [],
      contactNameUpdates: [],
      meetingContactLinks: [],
      companiesToCreate: [],
      meetingCompanyLinks: [{ meetingId, companyId: 'does-not-exist-' + createId(), seedKey: null, confidence: 0.7, linkedBy: 'auto' }],
      companyLinksToPrune: [],
      companyNameUpdates: [],
    }
    const loaded = { state: { contactsByEmail: new Map(), companies: [], currentMeetingCompanyLinkIds: [] }, tombstoned: new Set<string>(), primaryCompanyByContactId: new Map() }

    await expect(applyWritePlan(db, { userId: USER_ID, firmId: FIRM_ID, plan: poisonPlan, loaded, attendeeEmails: [at('jane')] })).rejects.toThrow()
    expect(await countContacts()).toBe(0) // rolled back
  })

  test('group-event plan is empty — no writes', async () => {
    const meetingId = await insertMeeting({ attendeeEmails: [at('a'), at('b')] })
    const attendees = [`A <${at('a')}>`, `B <${at('b')}>`]
    const attendeeEmails = [at('a'), at('b')]
    const candidates = buildCandidates(attendees, attendeeEmails, ownerEmail)
    const loaded = await loadExistingState(db, {
      firmId: FIRM_ID,
      candidateEmails: candidates.map((c) => c.email),
      seedNames: deriveSeedCompanyNames(attendees, attendeeEmails),
      attendeeEmails,
      meetingId,
    })
    const plan = planMeetingEnrichment(loaded.state, { attendees, attendeeEmails }, {
      meetingId,
      ownerEmail: ownerEmail,
      isGroupEvent: true, // group event → empty plan
      companies: undefined,
    })
    const { stats } = await applyWritePlan(db, { userId: USER_ID, firmId: FIRM_ID, plan, loaded, attendeeEmails })
    expect(stats).toEqual({ contactsCreated: 0, companiesCreated: 0, linksCreated: 0 })
    expect(await countContacts()).toBe(0)
    expect(await countCompanies()).toBe(0)
  })
})
