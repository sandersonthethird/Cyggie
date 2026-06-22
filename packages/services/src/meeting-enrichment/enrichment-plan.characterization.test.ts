// CHARACTERIZATION TEST (eng-review 3A) — the one test that proves the pure
// planner reproduces the DESKTOP's real, DB-backed behaviour. The golden fixtures
// assert "the planner does what the author THINKS desktop does"; this asserts
// "the planner ≡ what desktop ACTUALLY writes" for representative scenarios:
//   1. create + link   2. dedup + name-upgrade   3. company-link prune
// It runs the REAL desktop repos against an in-memory SQLite (harness mirrors
// src/tests/meeting-company-cascade-outbox.test.ts), reads the rows desktop wrote,
// and checks the WritePlan would produce equivalent writes. Isolated in its own
// file because it needs better-sqlite3 (the golden suite stays pure-TS).
//
// SCOPE: the planner only covers what the WritePlan models — contact rows + name
// updates, company create/match/link/prune. It does NOT model contact→primary-
// company linking or tombstone-skip (per-context persister concerns), so those
// columns are intentionally not asserted here.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'
import {
  planMeetingEnrichment,
  type ExistingCompany,
  type ExistingContact,
  type ExistingState,
} from './plan'

const USER_ID = 'user-1'
const USER_EMAIL = 'user-1@example.com'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createMeeting, updateMeeting, syncContactsFromAttendees } = await import(
  '@cyggie/db/sqlite/repositories'
)

// ── DB readers → planner ExistingState shapes ───────────────────────────────

interface ContactRow {
  id: string
  full_name: string
  normalized_name: string
  first_name: string | null
  last_name: string | null
  email: string | null
}
interface CompanyRow {
  id: string
  canonical_name: string
  normalized_name: string
  primary_domain: string | null
}

function readContact(email: string): ExistingContact | undefined {
  const r = testDb
    .prepare(
      'SELECT id, full_name, normalized_name, first_name, last_name, email FROM contacts WHERE lower(email) = ?',
    )
    .get(email.toLowerCase()) as ContactRow | undefined
  if (!r) return undefined
  const secondary = testDb
    .prepare('SELECT email FROM contact_emails WHERE contact_id = ?')
    .all(r.id) as Array<{ email: string }>
  const emails = [...new Set([r.email, ...secondary.map((s) => s.email)].filter((e): e is string => Boolean(e)))]
  return {
    id: r.id,
    fullName: r.full_name,
    normalizedName: r.normalized_name,
    firstName: r.first_name,
    lastName: r.last_name,
    primaryEmail: r.email,
  }
}

function readCompanies(): ExistingCompany[] {
  const rows = testDb
    .prepare('SELECT id, canonical_name, normalized_name, primary_domain FROM org_companies')
    .all() as CompanyRow[]
  return rows.map((r) => {
    const aliases = testDb
      .prepare('SELECT alias_value, alias_type FROM org_company_aliases WHERE company_id = ?')
      .all(r.id) as Array<{ alias_value: string; alias_type: string }>
    return {
      id: r.id,
      canonicalName: r.canonical_name,
      normalizedName: r.normalized_name,
      primaryDomain: r.primary_domain,
      nameAliases: aliases.filter((a) => a.alias_type === 'name').map((a) => a.alias_value),
      domainAliases: aliases.filter((a) => a.alias_type === 'domain').map((a) => a.alias_value),
    }
  })
}

function companyIdByNormalized(normalizedName: string): string | undefined {
  return readCompanies().find((c) => c.normalizedName === normalizedName)?.id
}

function meetingCompanyIds(meetingId: string): Set<string> {
  const rows = testDb
    .prepare('SELECT company_id FROM meeting_company_links WHERE meeting_id = ?')
    .all(meetingId) as Array<{ company_id: string }>
  return new Set(rows.map((r) => r.company_id))
}

const emptyState = (over: Partial<ExistingState> = {}): ExistingState => ({
  contactsByEmail: new Map(),
  companies: [],
  currentMeetingCompanyLinkIds: [],
  ...over,
})

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
    .run(USER_ID, USER_EMAIL, 'User One')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => USER_ID,
    getDeviceId: () => 'device-1',
  })
})

describe('planner ≡ desktop (characterization)', () => {
  it('scenario 1 — create contact + create company + link, on a fresh DB', () => {
    const attendees = ['Jane Doe <jane@acme.com>']
    const attendeeEmails = ['jane@acme.com']

    // Desktop path: company create+link via createMeeting, contacts via sync.
    const meeting = createMeeting(
      { title: 'Kickoff', date: '2026-06-22T10:00:00.000Z', companies: ['Acme'], attendeeEmails },
      USER_ID,
    )
    syncContactsFromAttendees(attendees, attendeeEmails, USER_ID)

    // Planner over the PRE-write (empty) state with the same inputs.
    const plan = planMeetingEnrichment(emptyState(), { attendees, attendeeEmails }, {
      meetingId: meeting.id,
      ownerEmail: USER_EMAIL,
      isGroupEvent: false,
      companies: ['Acme'],
    })

    // Contact: planner's intended create == the row desktop actually wrote.
    expect(plan.contactsToCreate).toHaveLength(1)
    const dbContact = readContact('jane@acme.com')
    expect(dbContact).toBeDefined()
    expect(plan.contactsToCreate[0]).toMatchObject({
      email: dbContact!.primaryEmail,
      fullName: dbContact!.fullName,
      normalizedName: dbContact!.normalizedName,
      firstName: dbContact!.firstName,
      lastName: dbContact!.lastName,
    })

    // Company: planner's intended create == the org_companies row desktop wrote.
    expect(plan.companiesToCreate).toHaveLength(1)
    const dbCompanies = readCompanies()
    expect(dbCompanies).toHaveLength(1)
    expect(plan.companiesToCreate[0]).toMatchObject({
      canonicalName: dbCompanies[0].canonicalName,
      normalizedName: dbCompanies[0].normalizedName,
      primaryDomain: dbCompanies[0].primaryDomain,
    })

    // Link: planner links via the new company's seedKey; desktop linked its id.
    expect(plan.meetingCompanyLinks).toEqual([
      { meetingId: meeting.id, companyId: null, seedKey: 'acme', confidence: 0.7, linkedBy: 'auto' },
    ])
    expect(meetingCompanyIds(meeting.id)).toEqual(new Set([dbCompanies[0].id]))
    expect(plan.companyLinksToPrune).toEqual([])
  })

  it('scenario 2 — dedup an existing low-quality contact and upgrade its name', () => {
    // Seed a low-quality existing contact ("jdoe") the desktop will upgrade.
    testDb
      .prepare(
        `INSERT INTO contacts (id, full_name, first_name, last_name, normalized_name, email, created_by_user_id, updated_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run('c-jdoe', 'jdoe', null, null, 'jdoe', 'jdoe@acme.com', USER_ID, USER_ID)

    const before = readContact('jdoe@acme.com')!
    const existing = emptyState({ contactsByEmail: new Map([['jdoe@acme.com', before]]) })

    const attendees = ['Jane Doe <jdoe@acme.com>']
    const attendeeEmails = ['jdoe@acme.com']

    // Desktop path.
    syncContactsFromAttendees(attendees, attendeeEmails, USER_ID)

    // Planner over the pre-sync state.
    const plan = planMeetingEnrichment(existing, { attendees, attendeeEmails }, {
      meetingId: 'm-2',
      ownerEmail: USER_EMAIL,
      isGroupEvent: false,
      companies: [],
    })

    // No new contact — it matched the existing row.
    expect(plan.contactsToCreate).toEqual([])

    // Planner's intended name update == the upgraded row desktop wrote.
    const after = readContact('jdoe@acme.com')!
    expect(after.id).toBe('c-jdoe')
    expect(after.fullName).toBe('Jane Doe') // desktop upgraded it
    expect(plan.contactNameUpdates).toEqual([
      {
        contactId: 'c-jdoe',
        fullName: after.fullName,
        normalizedName: after.normalizedName,
        firstName: after.firstName,
        lastName: after.lastName,
      },
    ])
  })

  it('scenario 3 — prune a meeting-company link that no longer resolves', () => {
    // Create a meeting linked to "Acme" (no emails → Acme has no primary domain,
    // so a later "Beta" can't accidentally domain-match it).
    const meeting = createMeeting(
      { title: 'Review', date: '2026-06-22T11:00:00.000Z', companies: ['Acme'] },
      USER_ID,
    )
    const acmeId = companyIdByNormalized('acme')!
    expect(meetingCompanyIds(meeting.id)).toEqual(new Set([acmeId]))

    const existing = emptyState({
      companies: readCompanies(),
      currentMeetingCompanyLinkIds: [acmeId],
    })

    // Planner: re-plan the same meeting with companies → ['Beta'].
    const plan = planMeetingEnrichment(existing, { attendees: null, attendeeEmails: null }, {
      meetingId: meeting.id,
      ownerEmail: USER_EMAIL,
      isGroupEvent: false,
      companies: ['Beta'],
    })

    // Desktop path: updateMeeting re-syncs links from the new companies list.
    updateMeeting(meeting.id, { companies: ['Beta'] }, USER_ID)

    // Planner intends to prune Acme + create/link Beta; desktop did exactly that.
    expect(plan.companyLinksToPrune).toEqual([{ meetingId: meeting.id, companyId: acmeId }])
    expect(plan.companiesToCreate).toHaveLength(1)
    expect(plan.companiesToCreate[0].normalizedName).toBe('beta')
    expect(plan.meetingCompanyLinks).toEqual([
      { meetingId: meeting.id, companyId: null, seedKey: 'beta', confidence: 0.7, linkedBy: 'auto' },
    ])

    const betaId = companyIdByNormalized('beta')!
    expect(meetingCompanyIds(meeting.id)).toEqual(new Set([betaId])) // Acme pruned, Beta linked
  })
})
