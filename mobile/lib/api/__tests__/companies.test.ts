import { describe, expect, it, vi } from 'vitest'
import type { CompaniesListResponse } from '../companies'

// companies.ts transitively imports the api client (expo/RN modules) and
// @tanstack/react-query. Mock the client so importing the pure helpers doesn't
// drag in native modules. We only test the pure logic
// (companiesNextPageParam + flattenCompaniesPages).
vi.mock('../client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiFetchRaw: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

const { companiesNextPageParam, COMPANIES_PAGE_LIMIT, flattenCompaniesPages } =
  await import('../companies')

// companiesNextPageParam only reads companies.length + total, so a minimal row
// shape cast to the real type keeps the test focused on the paging logic.
function page(count: number, total: number): CompaniesListResponse {
  return {
    companies: Array.from({ length: count }, (_, i) => ({ id: `c${i}` })),
    total,
  } as unknown as CompaniesListResponse
}

describe('companiesNextPageParam', () => {
  it('returns the next offset when a full page leaves more to load', () => {
    const p1 = page(COMPANIES_PAGE_LIMIT, 120)
    expect(companiesNextPageParam(p1, [p1])).toBe(COMPANIES_PAGE_LIMIT)
  })

  it('returns undefined once loaded rows reach total', () => {
    const p1 = page(COMPANIES_PAGE_LIMIT, 100)
    const p2 = page(COMPANIES_PAGE_LIMIT, 100)
    expect(companiesNextPageParam(p2, [p1, p2])).toBeUndefined()
  })

  it('returns undefined on a short page even if total claims more (divergence guard)', () => {
    // total=120 says there should be more, but the server returned a short
    // page — a row was deleted mid-scroll. Stop instead of looping forever.
    const p1 = page(COMPANIES_PAGE_LIMIT, 120)
    const p2 = page(COMPANIES_PAGE_LIMIT - 5, 120)
    expect(companiesNextPageParam(p2, [p1, p2])).toBeUndefined()
  })

  it('accumulates the offset across multiple loaded pages', () => {
    const p1 = page(COMPANIES_PAGE_LIMIT, 200)
    const p2 = page(COMPANIES_PAGE_LIMIT, 200)
    expect(companiesNextPageParam(p2, [p1, p2])).toBe(COMPANIES_PAGE_LIMIT * 2)
  })

  it('stops on an empty first page', () => {
    const p1 = page(0, 0)
    expect(companiesNextPageParam(p1, [p1])).toBeUndefined()
  })
})

describe('flattenCompaniesPages', () => {
  it('returns empty defaults for undefined (cold cache)', () => {
    expect(flattenCompaniesPages(undefined)).toEqual({ companies: [], total: 0 })
  })

  it('returns empty defaults for the OLD {companies,total} shape (the crash input)', () => {
    // A persisted pre-migration useQuery entry rehydrated under the infinite
    // query's key has no `pages`. The old code did `data.pages[0]` → undefined[0]
    // → TypeError → silent quit. The helper must degrade to empty (refetch
    // repopulates with the new shape).
    const oldShape = { companies: [{ id: 'c0' }], total: 1 } as unknown as {
      pages?: CompaniesListResponse[]
    }
    expect(flattenCompaniesPages(oldShape)).toEqual({ companies: [], total: 0 })
  })

  it('returns empty defaults for an empty pages array', () => {
    expect(flattenCompaniesPages({ pages: [] })).toEqual({ companies: [], total: 0 })
  })

  it('flattens a single page and reads total from page 0', () => {
    const r = flattenCompaniesPages({ pages: [page(3, 42)] })
    expect(r.companies).toHaveLength(3)
    expect(r.total).toBe(42)
  })

  it('concatenates companies across pages, total from the first page', () => {
    const r = flattenCompaniesPages({ pages: [page(50, 120), page(50, 120), page(20, 120)] })
    expect(r.companies).toHaveLength(120)
    expect(r.total).toBe(120)
  })

  it('tolerates a page missing its companies array (defensive)', () => {
    const bad = { total: 5 } as unknown as CompaniesListResponse
    expect(flattenCompaniesPages({ pages: [bad] })).toEqual({ companies: [], total: 5 })
  })
})
