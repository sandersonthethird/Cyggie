/**
 * Tests for listSuspectedDuplicateContacts.
 * Requires better-sqlite3 (native module).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../main/database/migrations/001-initial-schema'
import { runContactNamePartsMigration } from '../main/database/migrations/023-contact-name-parts'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { listSuspectedDuplicateContacts } = await import('../main/database/repositories/contact.repo')

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Minimal schema: contacts table with all columns needed by listSuspectedDuplicateContacts
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      first_name TEXT,
      last_name TEXT,
      normalized_name TEXT NOT NULL DEFAULT '',
      email TEXT,
      primary_company_id TEXT,
      title TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL DEFAULT ''
    );
  `)
  return db
}

function insertContact(db: Database.Database, opts: {
  id: string
  fullName: string
  normalizedName: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  updatedAt?: string
}) {
  db.prepare(`
    INSERT INTO contacts (id, full_name, normalized_name, first_name, last_name, email, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.fullName,
    opts.normalizedName,
    opts.firstName ?? null,
    opts.lastName ?? null,
    opts.email ?? null,
    opts.updatedAt ?? '2026-01-01 00:00:00'
  )
}

beforeEach(() => {
  testDb = makeTestDb()
})

// ── Exact match via normalized_name ────────────────────────────────────────────

describe('listSuspectedDuplicateContacts — exact match', () => {
  it('groups contacts sharing a normalized_name', () => {
    insertContact(testDb, { id: 'c1', fullName: 'John Monagle', normalizedName: 'john monagle' })
    insertContact(testDb, { id: 'c2', fullName: 'John Monagle', normalizedName: 'john monagle' })
    insertContact(testDb, { id: 'c3', fullName: 'John Monagle', normalizedName: 'john monagle' })

    const groups = listSuspectedDuplicateContacts()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.contacts).toHaveLength(3)
    expect(groups[0]!.confidence).toBeUndefined()
  })
})

// ── UNION match via first+last ──────────────────────────────────────────────────

describe('listSuspectedDuplicateContacts — UNION first+last match', () => {
  it('groups contacts with matching first+last but different normalized_name', () => {
    // Simulate a contact created with "Last, First" format (different normalized_name)
    insertContact(testDb, {
      id: 'c1',
      fullName: 'Alice Smith',
      normalizedName: 'alice smith',
      firstName: 'Alice',
      lastName: 'Smith'
    })
    insertContact(testDb, {
      id: 'c2',
      fullName: 'Smith, Alice',
      normalizedName: 'smith alice',  // different normalized_name
      firstName: 'Alice',
      lastName: 'Smith'
    })

    const groups = listSuspectedDuplicateContacts()
    expect(groups).toHaveLength(1)
    const ids = groups[0]!.contacts.map((c) => c.id)
    expect(ids).toContain('c1')
    expect(ids).toContain('c2')
  })
})

// ── Fuzzy match ────────────────────────────────────────────────────────────────

describe('listSuspectedDuplicateContacts — fuzzy match', () => {
  it('groups contacts with similar names (Jon vs John) with confidence set', () => {
    insertContact(testDb, { id: 'c1', fullName: 'Jon Monagle', normalizedName: 'jon monagle' })
    insertContact(testDb, { id: 'c2', fullName: 'John Monagle', normalizedName: 'john monagle' })

    const groups = listSuspectedDuplicateContacts()
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group.contacts).toHaveLength(2)
    expect(group.confidence).toBeDefined()
    expect(group.confidence).toBeGreaterThanOrEqual(85)
  })

  it('does NOT group contacts with dissimilar names', () => {
    insertContact(testDb, { id: 'c1', fullName: 'Alice Wong', normalizedName: 'alice wong' })
    insertContact(testDb, { id: 'c2', fullName: 'Bob Smith', normalizedName: 'bob smith' })

    const groups = listSuspectedDuplicateContacts()
    expect(groups).toHaveLength(0)
  })

  it('union-find produces ONE group for 3 pairwise-similar names', () => {
    // Jon / John / Jonn — all pairwise similar
    insertContact(testDb, { id: 'c1', fullName: 'Jon Monagle', normalizedName: 'jon monagle' })
    insertContact(testDb, { id: 'c2', fullName: 'John Monagle', normalizedName: 'john monagle' })
    insertContact(testDb, { id: 'c3', fullName: 'Jonn Monagle', normalizedName: 'jonn monagle' })

    const groups = listSuspectedDuplicateContacts()
    // Should be exactly 1 group of 3, not 3 groups of 2
    expect(groups).toHaveLength(1)
    expect(groups[0]!.contacts).toHaveLength(3)
  })
})
