/**
 * Tests for the org_companies-first precedence in company-enrichment.
 *
 * After a merge, the legacy `companies` cache may still hold the merged-away
 * source name keyed by a domain that now belongs to the target. To prevent
 * future calendar ingest from re-surfacing the wrong name, both
 * enrichCompany() and getCompanySuggestionsFromEmails() consult org_companies
 * (alias-aware) before falling back to the cache.
 *
 * Tests:
 *   - enrichCompany returns org_companies.canonicalName when domain matches
 *     primary_domain or alias_type='domain'
 *   - the lookup result is upserted into the cache to keep the fast path warm
 *   - getCompanySuggestionsFromEmails uses the same precedence
 *   - the website fetch / LLM are NOT invoked when org_companies wins
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// Sentinels — fail loudly if the new precedence accidentally falls through.
const netRequestSpy = vi.fn(() => {
  throw new Error('electron.net.request should not be called when org_companies wins')
})
vi.mock('electron', () => ({
  net: { request: (...args: unknown[]) => netRequestSpy(...args) }
}))

const llmGenerateSpy = vi.fn(() => {
  throw new Error('LLM should not be called when org_companies wins')
})
vi.mock('../main/llm/provider-factory', () => ({
  getProvider: () => ({ generate: (...args: unknown[]) => llmGenerateSpy(...args) })
}))

const { enrichCompany, getCompanySuggestionsFromEmails } = await import('../main/services/company-enrichment')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT,
      primary_domain TEXT,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      include_in_companies_view INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      UNIQUE(company_id, alias_value, alias_type)
    );
    CREATE TABLE companies (
      domain TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      enriched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

beforeEach(() => {
  testDb = buildDb()
  netRequestSpy.mockClear()
  llmGenerateSpy.mockClear()
})

describe('enrichCompany — org_companies precedence', () => {
  it("returns the org_companies canonical_name when the domain matches its primary_domain", async () => {
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES ('co1', 'Acme Inc.', 'acme.com')
    `).run()

    const result = await enrichCompany('acme.com')

    expect(result).toBe('Acme Inc.')
    expect(netRequestSpy).not.toHaveBeenCalled()
    expect(llmGenerateSpy).not.toHaveBeenCalled()
  })

  it("returns the org_companies canonical_name when the domain matches an alias_type='domain' alias", async () => {
    // Common post-merge state: target's primary_domain differs from one of
    // its alias domains (the source's old domain).
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES ('co1', 'Acme Inc.', 'acme.com')
    `).run()
    testDb.prepare(`
      INSERT INTO org_company_aliases (id, company_id, alias_value, alias_type)
      VALUES ('al1', 'co1', 'acme-corp.com', 'domain')
    `).run()

    const result = await enrichCompany('acme-corp.com')

    expect(result).toBe('Acme Inc.')
  })

  it('overrides a stale cache value when org_companies has a different name', async () => {
    // This is the post-merge scenario: cache says 'Acme Corp' (the merged-away
    // source name) but org_companies says 'Acme Inc.' (the kept target).
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES ('co1', 'Acme Inc.', 'acme.com')
    `).run()
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('acme.com', 'Acme Corp')`).run()

    const result = await enrichCompany('acme.com')

    expect(result).toBe('Acme Inc.')
    // Cache should now be rewritten to the canonical name.
    const cacheRow = testDb.prepare(`SELECT display_name FROM companies WHERE domain = ?`).get('acme.com') as { display_name: string }
    expect(cacheRow.display_name).toBe('Acme Inc.')
  })

  it('falls back to the cache when no org_companies row owns the domain', async () => {
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('orphan.example', 'OrphanCo')`).run()

    const result = await enrichCompany('orphan.example')

    expect(result).toBe('OrphanCo')
  })
})

describe('getCompanySuggestionsFromEmails — org_companies precedence', () => {
  it('uses the org_companies canonical_name for matching emails', () => {
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES ('co1', 'Acme Inc.', 'acme.com')
    `).run()
    // Stale cache with the wrong name — must not win over org_companies.
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('acme.com', 'Acme Corp')`).run()

    const suggestions = getCompanySuggestionsFromEmails(['ceo@acme.com'])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].name).toBe('Acme Inc.')
    expect(suggestions[0].domain).toBe('acme.com')
  })

  it('uses an alias domain hit', () => {
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES ('co1', 'Acme Inc.', 'acme.com')
    `).run()
    testDb.prepare(`
      INSERT INTO org_company_aliases (id, company_id, alias_value, alias_type)
      VALUES ('al1', 'co1', 'old-acme.com', 'domain')
    `).run()

    const suggestions = getCompanySuggestionsFromEmails(['user@old-acme.com'])

    expect(suggestions[0].name).toBe('Acme Inc.')
  })

  it('falls back to cache when no org_company owns the domain', () => {
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('cache-only.example', 'CacheOnly')`).run()

    const suggestions = getCompanySuggestionsFromEmails(['user@cache-only.example'])

    expect(suggestions[0].name).toBe('CacheOnly')
  })

  it('falls back to a domain heuristic when neither org nor cache has the domain', () => {
    const suggestions = getCompanySuggestionsFromEmails(['user@brand-new.example'])

    expect(suggestions[0].name).toBeTruthy() // domainToTitleCase output
    expect(suggestions[0].domain).toBe('brand-new.example')
  })
})
