/**
 * T3 · Slice 0 · Part 2 — the NO-BEHAVIOR-CHANGE proof (eng-review 5A).
 *
 * Captures the SQLite rows + outbox that desktop's enrichment entry points
 * (`syncContactsFromAttendees` / `syncContactsFromMeetings` / `createMeeting` /
 * `updateMeeting` → `syncMeetingCompanyLinks`) produce for a battery of fixtures,
 * as inline snapshots taken on the PRE-rewire commit. After the rewire onto the
 * shared planner + `SqliteEnrichmentStore`, the SAME projections must reproduce
 * them byte-for-byte (ids / timestamps / lamport are volatile, so the projection
 * resolves company ids → normalized names and asserts lamport is merely non-zero).
 *
 * Harness mirrors meeting-company-cascade-outbox.test.ts: full schema via
 * runAllMigrations, mocked connection, configured sync globals, barrel imports.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createMeeting, updateMeeting, syncContactsFromAttendees, syncContactsFromMeetings } =
  await import('@cyggie/db/sqlite/repositories')

const USER_ID = 'user-1'

// ── normalized projections (stable across ids / timestamps / lamport) ────────

function companyIdToNorm(): Map<string, string> {
  const rows = testDb.prepare('SELECT id, normalized_name FROM org_companies').all() as Array<{
    id: string
    normalized_name: string
  }>
  return new Map(rows.map((r) => [r.id, r.normalized_name]))
}

function contactIdToEmail(): Map<string, string | null> {
  const rows = testDb.prepare('SELECT id, email FROM contacts').all() as Array<{
    id: string
    email: string | null
  }>
  return new Map(rows.map((r) => [r.id, r.email]))
}

/** Owned-table rows, projected to stable fields and deterministically sorted. */
function projectState() {
  const comp = companyIdToNorm()
  const cid = contactIdToEmail()
  const norm = (id: string | null) => (id ? (comp.get(id) ?? `?${id}`) : null)

  const contacts = (
    testDb
      .prepare(
        'SELECT full_name, normalized_name, first_name, last_name, email, primary_company_id FROM contacts',
      )
      .all() as Array<Record<string, string | null>>
  )
    .map((c) => ({
      full_name: c.full_name,
      normalized_name: c.normalized_name,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      primary_company: norm(c.primary_company_id),
    }))
    .sort((a, b) => String(a.email).localeCompare(String(b.email)))

  const contactEmails = (
    testDb
      .prepare(
        `SELECT ce.email, ce.is_primary, c.email AS owner FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id`,
      )
      .all() as Array<{ email: string; is_primary: number; owner: string | null }>
  )
    .map((r) => ({ owner: r.owner, email: r.email, is_primary: r.is_primary }))
    .sort((a, b) => `${a.owner}|${a.email}`.localeCompare(`${b.owner}|${b.email}`))

  const companies = (
    testDb
      .prepare('SELECT canonical_name, normalized_name, primary_domain FROM org_companies')
      .all() as Array<Record<string, string | null>>
  ).sort((a, b) => String(a.normalized_name).localeCompare(String(b.normalized_name)))

  const aliases = (
    testDb
      .prepare('SELECT company_id, alias_value, alias_type FROM org_company_aliases')
      .all() as Array<{ company_id: string; alias_value: string; alias_type: string }>
  )
    .map((a) => ({ company: norm(a.company_id), alias_value: a.alias_value, alias_type: a.alias_type }))
    .sort((a, b) =>
      `${a.company}|${a.alias_type}|${a.alias_value}`.localeCompare(
        `${b.company}|${b.alias_type}|${b.alias_value}`,
      ),
    )

  const companyContacts = (
    testDb
      .prepare('SELECT company_id, contact_id, is_primary FROM org_company_contacts')
      .all() as Array<{ company_id: string; contact_id: string; is_primary: number }>
  )
    .map((r) => ({ company: norm(r.company_id), contact: cid.get(r.contact_id) ?? null, is_primary: r.is_primary }))
    .sort((a, b) => `${a.company}|${a.contact}`.localeCompare(`${b.company}|${b.contact}`))

  const links = (
    testDb
      .prepare('SELECT meeting_id, company_id, confidence, linked_by FROM meeting_company_links')
      .all() as Array<{ meeting_id: string; company_id: string; confidence: number; linked_by: string }>
  )
    .map((l) => ({ company: norm(l.company_id), confidence: l.confidence, linked_by: l.linked_by }))
    .sort((a, b) => String(a.company).localeCompare(String(b.company)))

  return { contacts, contactEmails, companies, aliases, companyContacts, links }
}

/** Outbox rows, projected to (table, op, stable key) and sorted. lamport asserted non-zero. */
function projectOutbox() {
  const comp = companyIdToNorm()
  const rows = testDb
    .prepare('SELECT table_name, op, payload FROM outbox ORDER BY id ASC')
    .all() as Array<{ table_name: string; op: string; payload: string }>

  let allLamportsOk = true
  const projected = rows.map((r) => {
    const p = JSON.parse(r.payload) as Record<string, unknown>
    if ('lamport' in p && (p.lamport === '0' || p.lamport == null)) allLamportsOk = false
    let key: string
    switch (r.table_name) {
      case 'contacts':
      case 'contact_emails':
        key = String(p.email)
        break
      case 'org_companies':
        key = String(p.canonical_name)
        break
      case 'org_company_aliases':
        key = `${p.alias_value}|${p.alias_type}`
        break
      case 'meeting_company_links':
        key = String(comp.get(String(p.company_id)) ?? p.company_id)
        break
      case 'meetings':
        key = String(p.title)
        break
      default:
        key = ''
    }
    return { table: r.table_name, op: r.op, key }
  })

  projected.sort((a, b) =>
    `${a.table}|${a.op}|${a.key}`.localeCompare(`${b.table}|${b.op}|${b.key}`),
  )
  return { rows: projected, allLamportsOk }
}

/** Let syncContactsFromAttendees' deferred autoLinkContactsByDomain (setImmediate) run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function seedContact(opts: {
  id: string
  fullName: string
  email: string | null
  normalizedName?: string
  firstName?: string | null
  lastName?: string | null
}): void {
  testDb
    .prepare(
      `INSERT INTO contacts (id, full_name, first_name, last_name, normalized_name, email, created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      opts.id,
      opts.fullName,
      opts.firstName ?? null,
      opts.lastName ?? null,
      opts.normalizedName ?? opts.fullName.toLowerCase(),
      opts.email,
      USER_ID,
      USER_ID,
    )
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
    .run(USER_ID, 'user-1@example.com', 'User One')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => USER_ID,
    getDeviceId: () => 'device-1',
  })
})

describe('enrichment parity — contacts', () => {
  it('creates a brand-new contact + emits outbox', async () => {
    syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], USER_ID)
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "jane@acme.com",
            "is_primary": 1,
            "owner": "jane@acme.com",
          },
        ],
        "contacts": [
          {
            "email": "jane@acme.com",
            "first_name": "Jane",
            "full_name": "Jane Doe",
            "last_name": "Doe",
            "normalized_name": "jane doe",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    const ob = projectOutbox()
    expect(ob.allLamportsOk).toBe(true)
    expect(ob.rows).toMatchInlineSnapshot(`
      [
        {
          "key": "jane@acme.com",
          "op": "insert",
          "table": "contact_emails",
        },
        {
          "key": "jane@acme.com",
          "op": "insert",
          "table": "contacts",
        },
      ]
    `)
  })

  it('no-ops an already-existing contact (second sync emits nothing)', async () => {
    syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], USER_ID)
    await flush()
    testDb.exec('DELETE FROM outbox')
    syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], USER_ID)
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "jane@acme.com",
            "is_primary": 1,
            "owner": "jane@acme.com",
          },
        ],
        "contacts": [
          {
            "email": "jane@acme.com",
            "first_name": "Jane",
            "full_name": "Jane Doe",
            "last_name": "Doe",
            "normalized_name": "jane doe",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`[]`)
  })

  it('upgrades a low-quality stored name from an explicit attendee name', async () => {
    seedContact({ id: 'c-jdoe', fullName: 'jdoe', normalizedName: 'jdoe', email: 'jdoe@acme.com' })
    syncContactsFromAttendees(['Jane Doe <jdoe@acme.com>'], ['jdoe@acme.com'], USER_ID)
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "jdoe@acme.com",
            "is_primary": 1,
            "owner": "jdoe@acme.com",
          },
        ],
        "contacts": [
          {
            "email": "jdoe@acme.com",
            "first_name": "Jane",
            "full_name": "Jane Doe",
            "last_name": "Doe",
            "normalized_name": "jane doe",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`[]`)
  })

  it('backfills a blank primary email on a contact matched by a secondary email', async () => {
    seedContact({ id: 'c-blank', fullName: 'Pat Blank', normalizedName: 'pat blank', email: null })
    testDb
      .prepare('INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 0)')
      .run('c-blank', 'pat@beta.com')
    syncContactsFromAttendees(['Pat Blank <pat@beta.com>'], ['pat@beta.com'], USER_ID)
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "pat@beta.com",
            "is_primary": 1,
            "owner": "pat@beta.com",
          },
        ],
        "contacts": [
          {
            "email": "pat@beta.com",
            "first_name": "Pat",
            "full_name": "Pat Blank",
            "last_name": "Blank",
            "normalized_name": "pat blank",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`[]`)
  })

  it('skips creating a contact for a tombstoned email', async () => {
    testDb
      .prepare('INSERT INTO contact_tombstones (id, email, user_id) VALUES (?, ?, ?)')
      .run('t1', 'ghost@acme.com', USER_ID)
    syncContactsFromAttendees(
      ['Ghost <ghost@acme.com>', 'Real <real@acme.com>'],
      ['ghost@acme.com', 'real@acme.com'],
      USER_ID,
    )
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "real@acme.com",
            "is_primary": 1,
            "owner": "real@acme.com",
          },
        ],
        "contacts": [
          {
            "email": "real@acme.com",
            "first_name": null,
            "full_name": "Real",
            "last_name": null,
            "normalized_name": "real",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`
      [
        {
          "key": "real@acme.com",
          "op": "insert",
          "table": "contact_emails",
        },
        {
          "key": "real@acme.com",
          "op": "insert",
          "table": "contacts",
        },
      ]
    `)
  })

  it('syncContactsFromMeetings ignores group-event meetings', async () => {
    testDb
      .prepare(
        `INSERT INTO meetings (id, title, date, attendee_emails, is_group_event, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('m-group', 'Webinar', '2026-06-20T10:00:00Z', JSON.stringify(['crowd@acme.com']), 1, USER_ID, USER_ID)
    testDb
      .prepare(
        `INSERT INTO meetings (id, title, date, attendee_emails, is_group_event, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('m-1on1', 'Coffee', '2026-06-20T11:00:00Z', JSON.stringify(['friend@beta.com']), 0, USER_ID, USER_ID)
    syncContactsFromMeetings(USER_ID)
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "friend@beta.com",
            "is_primary": 1,
            "owner": "friend@beta.com",
          },
        ],
        "contacts": [
          {
            "email": "friend@beta.com",
            "first_name": null,
            "full_name": "Friend",
            "last_name": null,
            "normalized_name": "friend",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`
      [
        {
          "key": "friend@beta.com",
          "op": "insert",
          "table": "contact_emails",
        },
        {
          "key": "friend@beta.com",
          "op": "insert",
          "table": "contacts",
        },
      ]
    `)
  })
})

describe('enrichment parity — companies', () => {
  it('creates a company + aliases + link on a fresh meeting', async () => {
    createMeeting(
      { title: 'Kickoff', date: '2026-06-18T10:00:00.000Z', companies: ['Superlog'], attendeeEmails: ['ceo@superlog.com'] },
      USER_ID,
    )
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [
          {
            "alias_type": "domain",
            "alias_value": "superlog.com",
            "company": "superlog",
          },
          {
            "alias_type": "domain",
            "alias_value": "www.superlog.com",
            "company": "superlog",
          },
          {
            "alias_type": "name",
            "alias_value": "Superlog",
            "company": "superlog",
          },
        ],
        "companies": [
          {
            "canonical_name": "Superlog",
            "normalized_name": "superlog",
            "primary_domain": "superlog.com",
          },
        ],
        "companyContacts": [],
        "contactEmails": [],
        "contacts": [],
        "links": [
          {
            "company": "superlog",
            "confidence": 0.7,
            "linked_by": "auto",
          },
        ],
      }
    `)
    const ob = projectOutbox()
    expect(ob.allLamportsOk).toBe(true)
    expect(ob.rows).toMatchInlineSnapshot(`
      [
        {
          "key": "superlog",
          "op": "insert",
          "table": "meeting_company_links",
        },
        {
          "key": "Kickoff",
          "op": "insert",
          "table": "meetings",
        },
        {
          "key": "Superlog",
          "op": "insert",
          "table": "org_companies",
        },
        {
          "key": "superlog.com|domain",
          "op": "insert",
          "table": "org_company_aliases",
        },
        {
          "key": "Superlog|name",
          "op": "insert",
          "table": "org_company_aliases",
        },
        {
          "key": "www.superlog.com|domain",
          "op": "insert",
          "table": "org_company_aliases",
        },
      ]
    `)
  })

  it('matches an existing company by name instead of recreating it', async () => {
    createMeeting(
      { title: 'M1', date: '2026-06-18T10:00:00.000Z', companies: ['Superlog'], attendeeEmails: ['ceo@superlog.com'] },
      USER_ID,
    )
    testDb.exec('DELETE FROM outbox')
    const m2 = createMeeting(
      { title: 'M2', date: '2026-06-18T12:00:00.000Z', companies: ['Superlog'], attendeeEmails: ['cto@superlog.com'] },
      USER_ID,
    )
    void m2
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [
          {
            "alias_type": "domain",
            "alias_value": "superlog.com",
            "company": "superlog",
          },
          {
            "alias_type": "domain",
            "alias_value": "www.superlog.com",
            "company": "superlog",
          },
          {
            "alias_type": "name",
            "alias_value": "Superlog",
            "company": "superlog",
          },
        ],
        "companies": [
          {
            "canonical_name": "Superlog",
            "normalized_name": "superlog",
            "primary_domain": "superlog.com",
          },
        ],
        "companyContacts": [],
        "contactEmails": [],
        "contacts": [],
        "links": [
          {
            "company": "superlog",
            "confidence": 0.7,
            "linked_by": "auto",
          },
          {
            "company": "superlog",
            "confidence": 0.7,
            "linked_by": "auto",
          },
        ],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`
      [
        {
          "key": "superlog",
          "op": "insert",
          "table": "meeting_company_links",
        },
        {
          "key": "M2",
          "op": "insert",
          "table": "meetings",
        },
      ]
    `)
  })

  it('prunes a stale company link when the meeting company changes', async () => {
    // No attendeeEmails → Acme has no primary domain, so the new 'Beta' seed
    // can't domain-match it; this exercises a real prune (Acme) + create (Beta).
    const m = createMeeting(
      { title: 'Review', date: '2026-06-18T10:00:00.000Z', companies: ['Acme'] },
      USER_ID,
    )
    testDb.exec('DELETE FROM outbox')
    updateMeeting(m.id, { companies: ['Beta'] }, USER_ID)
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [
          {
            "alias_type": "name",
            "alias_value": "Acme",
            "company": "acme",
          },
          {
            "alias_type": "name",
            "alias_value": "Beta",
            "company": "beta",
          },
        ],
        "companies": [
          {
            "canonical_name": "Acme",
            "normalized_name": "acme",
            "primary_domain": null,
          },
          {
            "canonical_name": "Beta",
            "normalized_name": "beta",
            "primary_domain": null,
          },
        ],
        "companyContacts": [],
        "contactEmails": [],
        "contacts": [],
        "links": [
          {
            "company": "beta",
            "confidence": 0.7,
            "linked_by": "auto",
          },
        ],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`
      [
        {
          "key": "acme",
          "op": "delete",
          "table": "meeting_company_links",
        },
        {
          "key": "beta",
          "op": "insert",
          "table": "meeting_company_links",
        },
        {
          "key": "Review",
          "op": "update",
          "table": "meetings",
        },
        {
          "key": "Beta",
          "op": "insert",
          "table": "org_companies",
        },
        {
          "key": "Beta|name",
          "op": "insert",
          "table": "org_company_aliases",
        },
      ]
    `)
  })

  it('impromptu meeting (no companies) then recording-start contact sync', async () => {
    const m = createMeeting(
      { title: 'Impromptu', date: '2026-06-18T10:00:00.000Z', attendeeEmails: ['guest@gamma.com'] },
      USER_ID,
    )
    void m
    syncContactsFromAttendees(['Guest <guest@gamma.com>'], ['guest@gamma.com'], USER_ID)
    await flush()
    expect(projectState()).toMatchInlineSnapshot(`
      {
        "aliases": [],
        "companies": [],
        "companyContacts": [],
        "contactEmails": [
          {
            "email": "guest@gamma.com",
            "is_primary": 1,
            "owner": "guest@gamma.com",
          },
        ],
        "contacts": [
          {
            "email": "guest@gamma.com",
            "first_name": null,
            "full_name": "Guest",
            "last_name": null,
            "normalized_name": "guest",
            "primary_company": null,
          },
        ],
        "links": [],
      }
    `)
    expect(projectOutbox().rows).toMatchInlineSnapshot(`
      [
        {
          "key": "guest@gamma.com",
          "op": "insert",
          "table": "contact_emails",
        },
        {
          "key": "guest@gamma.com",
          "op": "insert",
          "table": "contacts",
        },
        {
          "key": "Impromptu",
          "op": "insert",
          "table": "meetings",
        },
      ]
    `)
  })
})
