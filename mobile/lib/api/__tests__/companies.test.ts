import { describe, expect, it, vi } from 'vitest'
import type { CompaniesListResponse } from '../companies'

// companies.ts transitively imports the api client (expo/RN modules) and
// @tanstack/react-query. Mock the client so importing the pure helper doesn't
// drag in native modules. We only test companiesNextPageParam (pure logic).
vi.mock('../client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiFetchRaw: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

const { companiesNextPageParam, COMPANIES_PAGE_LIMIT } = await import('../companies')

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
