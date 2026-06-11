/**
 * Tests for cascadeCompanyRename — the single-source-of-truth rename helper.
 *
 * Renaming a company (org_companies.canonical_name) must propagate to every
 * DENORMALIZED copy so the user fixes a bad/auto-derived name in ONE place:
 *   - meetings.companies          (JSON array of name strings)
 *   - contacts.previous_companies (JSON array of string | {name, companyId})
 *   - companies                   (legacy domain → display_name cache)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { cascadeCompanyRename } = await import('@cyggie/db/sqlite/repositories/org-company.repo')

const OLD = 'Streamlining The Middle-Market Deal Landscape'
const NEW = 'CapHub'
const CID = 'co-caphub'

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meetings (id TEXT PRIMARY KEY, companies TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, previous_companies TEXT);
    CREATE TABLE companies (domain TEXT PRIMARY KEY, display_name TEXT NOT NULL);
  `)
  return db
}

beforeEach(() => {
  testDb = buildDb()
})

describe('cascadeCompanyRename', () => {
  it('rewrites the name inside meetings.companies JSON arrays', () => {
    testDb.prepare('INSERT INTO meetings VALUES (?, ?)').run('m1', JSON.stringify([OLD, 'Acme']))
    testDb.prepare('INSERT INTO meetings VALUES (?, ?)').run('m2', JSON.stringify(['Unrelated']))

    const stats = cascadeCompanyRename(testDb, CID, OLD, NEW)

    const companiesOf = (id: string) =>
      (testDb.prepare('SELECT companies FROM meetings WHERE id=?').get(id) as { companies: string }).companies

    expect(stats.meetings).toBe(1)
    // Helper removes the old name and appends the new one (mergeCompanies order).
    expect(JSON.parse(companiesOf('m1'))).toEqual(['Acme', NEW])
    // Untouched meeting stays as-is.
    expect(companiesOf('m2')).toBe(JSON.stringify(['Unrelated']))
  })

  it('de-dupes when the new name is already present in the array', () => {
    testDb.prepare('INSERT INTO meetings VALUES (?, ?)').run('m1', JSON.stringify([OLD, NEW]))

    cascadeCompanyRename(testDb, CID, OLD, NEW)

    const after = JSON.parse((testDb.prepare('SELECT companies FROM meetings WHERE id=?').get('m1') as { companies: string }).companies)
    expect(after).toEqual([NEW])
  })

  it('rewrites contacts.previous_companies for both string and object entries', () => {
    testDb.prepare('INSERT INTO contacts VALUES (?, ?)').run('c1', JSON.stringify([OLD, 'Bonobos']))
    testDb.prepare('INSERT INTO contacts VALUES (?, ?)').run('c2', JSON.stringify([{ name: OLD, companyId: CID }]))
    // Matches by companyId even if the stored name drifted.
    testDb.prepare('INSERT INTO contacts VALUES (?, ?)').run('c3', JSON.stringify([{ name: 'Stale Name', companyId: CID }]))

    const stats = cascadeCompanyRename(testDb, CID, OLD, NEW)

    expect(stats.contacts).toBe(3)
    expect(JSON.parse((testDb.prepare('SELECT previous_companies FROM contacts WHERE id=?').get('c1') as { previous_companies: string }).previous_companies))
      .toEqual([NEW, 'Bonobos'])
    expect(JSON.parse((testDb.prepare('SELECT previous_companies FROM contacts WHERE id=?').get('c2') as { previous_companies: string }).previous_companies))
      .toEqual([{ name: NEW, companyId: CID }])
    expect(JSON.parse((testDb.prepare('SELECT previous_companies FROM contacts WHERE id=?').get('c3') as { previous_companies: string }).previous_companies))
      .toEqual([{ name: NEW, companyId: CID }])
  })

  it('handles a bare (non-JSON) previous_companies string', () => {
    testDb.prepare('INSERT INTO contacts VALUES (?, ?)').run('c1', OLD)

    const stats = cascadeCompanyRename(testDb, CID, OLD, NEW)

    expect(stats.contacts).toBe(1)
    expect(JSON.parse((testDb.prepare('SELECT previous_companies FROM contacts WHERE id=?').get('c1') as { previous_companies: string }).previous_companies))
      .toEqual([NEW])
  })

  it('rewrites the legacy domain → display_name cache', () => {
    testDb.prepare('INSERT INTO companies VALUES (?, ?)').run('caphub.com', OLD)
    testDb.prepare('INSERT INTO companies VALUES (?, ?)').run('other.com', 'Other Co')

    const stats = cascadeCompanyRename(testDb, CID, OLD, NEW)

    expect(stats.cache).toBe(1)
    expect((testDb.prepare('SELECT display_name FROM companies WHERE domain=?').get('caphub.com') as { display_name: string }).display_name).toBe(NEW)
    expect((testDb.prepare('SELECT display_name FROM companies WHERE domain=?').get('other.com') as { display_name: string }).display_name).toBe('Other Co')
  })

  it('is a no-op when the name is unchanged', () => {
    testDb.prepare('INSERT INTO meetings VALUES (?, ?)').run('m1', JSON.stringify([NEW]))
    const stats = cascadeCompanyRename(testDb, CID, NEW, NEW)
    expect(stats).toEqual({ meetings: 0, contacts: 0, cache: 0 })
  })
})
