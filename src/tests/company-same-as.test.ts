/**
 * Companies — user-asserted "Same as…" aliases (P2).
 *
 * Non-destructive duplicate marking stored in org_company_aliases with
 * alias_type='same_as' (the `alias_value` column overloaded to hold the OTHER
 * company's id). Surfaced as a user-confirmed tier-0 group at the top of the
 * suspected-duplicates list. Reuses the real migration schema so the dedup
 * query, the owned-table outbox emission, and the canonical-edge model are all
 * exercised end to end.
 *
 *   addSameAsAlias(A,B) ─┐ canonical (min,max) row ┌─▶ outbox insert (lamport>0)
 *                        ├─ idempotent under ──────┤
 *   addSameAsAlias(B,A) ─┘ UNIQUE(co,type,value)   └─▶ listSuspected… tier 0
 *
 * Boundaries:
 *   • Full runAllMigrations schema (org_company_aliases has lamport; outbox +
 *     sync_state present) + a `users` row + configured sync globals so the
 *     barrel's runInSyncBatch establishes a context and rows reach the outbox.
 *   • Imports from the BARREL (sync-wrapped). listSuspectedDuplicateCompanies
 *     is a read, imported the same way.
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
const {
  createCompany,
  addSameAsAlias,
  removeSameAsAlias,
  mergeCompanies,
  listSuspectedDuplicateCompanies,
} = await import('@cyggie/db/sqlite/repositories')

interface AliasOutboxRow {
  row_id: string
  op: 'insert' | 'update' | 'delete'
  payload: string
  lamport: string
}

function aliasOutbox(): AliasOutboxRow[] {
  return testDb
    .prepare(
      `SELECT row_id, op, payload, lamport FROM outbox
       WHERE table_name = 'org_company_aliases' ORDER BY id ASC`,
    )
    .all() as AliasOutboxRow[]
}

function sameAsRowCount(): number {
  return (
    testDb
      .prepare(`SELECT count(*) AS n FROM org_company_aliases WHERE alias_type = 'same_as'`)
      .get() as { n: number }
  ).n
}

function mkCompany(name: string, domain?: string): string {
  return createCompany({ canonicalName: name, ...(domain ? { primaryDomain: domain } : {}) }, 'user-1').id
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES ('user-1', 'u1@example.com', 'User One')`)
    .run()
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1',
    getDeviceId: () => 'device-1',
  })
})

describe('addSameAsAlias — emission + canonical idempotency', () => {
  it('inserts one canonical row and emits one outbox insert stamped with a real lamport', () => {
    const a = mkCompany('Twitter')
    const b = mkCompany('X')
    testDb.exec(`DELETE FROM outbox`) // drop the createCompany name-alias rows

    const res = addSameAsAlias(a, b)
    expect(res.linked).toBe(true)
    expect(sameAsRowCount()).toBe(1)

    const rows = aliasOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.op).toBe('insert')
    expect(rows[0]!.lamport).not.toBe('0') // stamped inside the sync batch
    const payload = JSON.parse(rows[0]!.payload)
    expect(payload.aliasType).toBe('same_as')
    // Canonical: company_id = min(a,b), alias_value = max(a,b).
    const [lo, hi] = a < b ? [a, b] : [b, a]
    expect(payload.companyId).toBe(lo)
    expect(payload.aliasValue).toBe(hi)
  })

  it('is idempotent: asserting the reverse direction hits the same row, no second emit', () => {
    const a = mkCompany('FedEx')
    const b = mkCompany('Federal Express')
    testDb.exec(`DELETE FROM outbox`)

    expect(addSameAsAlias(a, b).linked).toBe(true)
    // Reverse direction + exact repeat — both no-op.
    expect(addSameAsAlias(b, a).linked).toBe(false)
    expect(addSameAsAlias(a, b).linked).toBe(false)

    expect(sameAsRowCount()).toBe(1)
    expect(aliasOutbox()).toHaveLength(1) // only the first assertion emitted
  })

  it('rejects self-links and unknown companies without emitting', () => {
    const a = mkCompany('Acme')
    testDb.exec(`DELETE FROM outbox`)

    expect(addSameAsAlias(a, a).linked).toBe(false)
    expect(addSameAsAlias(a, 'does-not-exist').linked).toBe(false)
    expect(sameAsRowCount()).toBe(0)
    expect(aliasOutbox()).toHaveLength(0)
  })
})

describe('removeSameAsAlias — undo emits a delete', () => {
  it('deletes the canonical row and emits one delete', () => {
    const a = mkCompany('Meta')
    const b = mkCompany('Facebook')
    addSameAsAlias(a, b)
    testDb.exec(`DELETE FROM outbox`)

    const res = removeSameAsAlias(b, a) // reverse direction still resolves
    expect(res.removed).toBe(1)
    expect(sameAsRowCount()).toBe(0)

    const rows = aliasOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.op).toBe('delete')
  })

  it('no-ops (no emit) when the pair was never linked', () => {
    const a = mkCompany('Alpha')
    const b = mkCompany('Beta')
    testDb.exec(`DELETE FROM outbox`)
    expect(removeSameAsAlias(a, b).removed).toBe(0)
    expect(aliasOutbox()).toHaveLength(0)
  })
})

describe('listSuspectedDuplicateCompanies — tier 0 (user-confirmed)', () => {
  it('surfaces a same_as pair as the TOP group even when names/domains differ', () => {
    const tw = mkCompany('Twitter', 'twitter.com')
    const x = mkCompany('X', 'x.com')
    addSameAsAlias(tw, x)

    const groups = listSuspectedDuplicateCompanies()
    expect(groups.length).toBeGreaterThanOrEqual(1)
    const top = groups[0]!
    expect(top.key.startsWith('same_as:')).toBe(true)
    expect(top.reason).toMatch(/user confirmed/i)
    expect(top.confidence).toBe(100)
    expect(top.companies.map((c) => c.id).sort()).toEqual([tw, x].sort())
  })

  it('clusters transitive edges A–B and B–C into one group of three', () => {
    const a = mkCompany('Aye')
    const b = mkCompany('Bee')
    const c = mkCompany('Cee')
    addSameAsAlias(a, b)
    addSameAsAlias(b, c)

    const groups = listSuspectedDuplicateCompanies()
    const sameAs = groups.filter((g) => g.key.startsWith('same_as:'))
    expect(sameAs).toHaveLength(1)
    expect(sameAs[0]!.companies.map((co) => co.id).sort()).toEqual([a, b, c].sort())
  })

  it('drops a dangling edge whose other endpoint was deleted (no phantom, no crash)', () => {
    const a = mkCompany('Keep')
    const b = mkCompany('Gone')
    addSameAsAlias(a, b)
    // Hard-delete b's company row but leave the reverse edge (company_id=a,
    // alias_value=b) — the FK cascade only cleans the company_id=b side.
    testDb.prepare(`DELETE FROM org_companies WHERE id = ?`).run(b)

    const groups = listSuspectedDuplicateCompanies()
    expect(groups.filter((g) => g.key.startsWith('same_as:'))).toHaveLength(0)
  })

  it('suppresses a same_as member from the fuzzy tier (appears once, in tier 0)', () => {
    // co1 + co2 are a confirmed same_as pair; co3 fuzzy-matches co2 by name.
    const c1 = mkCompany('Stillers')
    const c2 = mkCompany('Stillers Soda')
    const c3 = mkCompany('Stillerssoda')
    addSameAsAlias(c1, c2)

    const groups = listSuspectedDuplicateCompanies()
    const sameAs = groups.filter((g) => g.key.startsWith('same_as:'))
    expect(sameAs).toHaveLength(1)
    // c2 must not also appear in any non-same_as group.
    const otherGroups = groups.filter((g) => !g.key.startsWith('same_as:'))
    for (const g of otherGroups) {
      expect(g.companies.map((co) => co.id)).not.toContain(c2)
    }
    expect(sameAs[0]!.companies.map((co) => co.id)).toContain(c2)
    void c3
  })
})

describe('legacy alias paths — Decision C outbox parity', () => {
  it('createCompany emits its name alias to the outbox (was previously stranded)', () => {
    createCompany({ canonicalName: 'Initech', primaryDomain: 'initech.com' }, 'user-1')
    const aliasRows = aliasOutbox()
    // At least the name alias is emitted; every emitted row carries a real lamport.
    expect(aliasRows.length).toBeGreaterThan(0)
    expect(aliasRows.every((r) => r.op === 'insert')).toBe(true)
    expect(aliasRows.every((r) => r.lamport !== '0')).toBe(true)
    const types = aliasRows.map((r) => JSON.parse(r.payload).aliasType)
    expect(types).toContain('name')
  })

  it('mergeCompanies copies name/domain aliases but NOT same_as edges', () => {
    const target = mkCompany('BigCo', 'bigco.com')
    const source = mkCompany('BigCorp', 'bigcorp.com')
    const other = mkCompany('Unrelated')
    // source is marked "same as" other — that edge must not be re-homed onto target.
    addSameAsAlias(source, other)

    mergeCompanies(target, source)

    // target now owns a domain alias copied from source, but no same_as row.
    const targetSameAs = testDb
      .prepare(
        `SELECT count(*) AS n FROM org_company_aliases
         WHERE company_id = ? AND alias_type = 'same_as'`,
      )
      .get(target) as { n: number }
    expect(targetSameAs.n).toBe(0)
    const targetDomainAliases = testDb
      .prepare(
        `SELECT count(*) AS n FROM org_company_aliases
         WHERE company_id = ? AND alias_type IN ('name', 'domain')`,
      )
      .get(target) as { n: number }
    expect(targetDomainAliases.n).toBeGreaterThan(0)
  })
})
