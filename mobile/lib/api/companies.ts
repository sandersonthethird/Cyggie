import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query'
import { api, apiFetchRaw, ApiError } from './client'

// Typed client for /companies/* gateway routes. Mirrors api/calendar.ts shape.

export interface CompanyListItem {
  id: string
  name: string
  industry: string | null
  stage: string | null
  pipelineStage: string | null
  status: string
  city: string | null
  state: string | null
  primaryDomain: string | null
  lastTouchAt: string | null
  meetingCount: number
}

export interface CompanyMeetingRef {
  id: string
  title: string
  date: string
  durationSeconds: number | null
}

export interface CompanyPersonRef {
  id: string
  fullName: string
  title: string | null
  email: string | null
}

export interface CompanyDetail extends CompanyListItem {
  description: string | null
  websiteUrl: string | null
  linkedinCompanyUrl: string | null
  employeeCountRange: string | null
  foundingYear: number | null
  arr: number | null
  runwayMonths: number | null
  round: string | null
  raiseSize: number | null
  totalFundingRaised: number | null
  /** AI-generated bullets — read-only on mobile (Generate is desktop-only). */
  keyTakeaways: string | null
  /** User-authored note pinned to the top of the Key Takeaways card. */
  keyTakeawaysUserNote: string | null
  recentMeetings: CompanyMeetingRef[]
  people: CompanyPersonRef[]
  // The gateway returns a guarded passthrough of the full row, so every other
  // business column (portfolio / investment / links / etc.) arrives too. The
  // generic ledger renderer reads these by key — see lib/ledger/buildGroups.ts.
  [key: string]: unknown
}

interface FetchCompaniesOpts {
  q?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}

export interface CompaniesListResponse {
  companies: CompanyListItem[]
  total: number
}

export async function fetchCompanies(
  opts: FetchCompaniesOpts = {},
): Promise<CompaniesListResponse> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.offset !== undefined) params.set('offset', String(opts.offset))
  const qs = params.toString()
  const path = qs ? `/companies?${qs}` : '/companies'
  return api.get<CompaniesListResponse>(path, { signal: opts.signal })
}

// Page size for the Companies tab infinite scroll. 50 keeps each round-trip
// light while still covering a single-firm CRM in a handful of pages.
export const COMPANIES_PAGE_LIMIT = 50

/**
 * Decide the next offset for the companies infinite query, or `undefined` to
 * stop. Pure + exported so it can be unit-tested without a React harness.
 *
 * Stops on EITHER condition (belt-and-suspenders): we've loaded `total` rows,
 * OR the server returned a short page. The short-page guard prevents an
 * infinite fetch loop if `total` (a separate COUNT query) and the summed page
 * lengths diverge — e.g. a company deleted mid-scroll leaves `total` higher
 * than the rows we can actually page through.
 */
export function companiesNextPageParam(
  lastPage: CompaniesListResponse,
  allPages: CompaniesListResponse[],
): number | undefined {
  const loaded = allPages.reduce((n, p) => n + p.companies.length, 0)
  if (loaded >= lastPage.total) return undefined
  if (lastPage.companies.length < COMPANIES_PAGE_LIMIT) return undefined
  return loaded
}

/**
 * Flatten an infinite-query companies cache into `{ companies, total }`,
 * tolerant of a stale/old-shaped persisted entry.
 *
 * The Companies list moved from `useQuery` (data shape `{ companies, total }`)
 * to `useInfiniteQuery` (`{ pages, pageParams }`) under the SAME query key
 * `['companies','list',q]`. The whole React Query cache is persisted to MMKV
 * unfiltered, so a pre-migration entry can rehydrate with the OLD shape (no
 * `pages`). Reading `data.pages[0]` on that shape threw `undefined[0]` and
 * silently crashed the tab on mount. This returns safe defaults for `undefined`,
 * the old `{ companies, total }` shape, and an empty `{ pages: [] }`; and the
 * real values for `{ pages: [...] }`. Pure + exported so it's unit-testable
 * without a render harness (mirrors `companiesNextPageParam`).
 *
 *   data                         → result
 *   undefined                    → { companies: [], total: 0 }
 *   { companies, total }  (old)  → { companies: [], total: 0 }  (refetch repopulates)
 *   { pages: [] }                → { companies: [], total: 0 }
 *   { pages: [p0, p1, ...] }     → { companies: p0∪p1∪…, total: p0.total }
 */
export function flattenCompaniesPages(
  data: { pages?: CompaniesListResponse[] } | undefined,
): { companies: CompanyListItem[]; total: number } {
  const pages = data?.pages
  if (!Array.isArray(pages) || pages.length === 0) {
    return { companies: [], total: 0 }
  }
  return {
    companies: pages.flatMap((p) => p.companies ?? []),
    total: pages[0]?.total ?? 0,
  }
}

/**
 * Infinite-scroll companies list keyed on the search term. Mirrors
 * `useCalendarInfiniteQuery` — `fetchCompanies` is the per-page fetcher and the
 * `pageParam` is the offset. Switching `q` creates a fresh infinite query.
 */
export function useCompaniesInfiniteQuery(opts: {
  q?: string
}): UseInfiniteQueryResult<
  { pages: CompaniesListResponse[]; pageParams: number[] },
  Error
> {
  return useInfiniteQuery({
    queryKey: ['companies', 'list', opts.q ?? ''] as const,
    queryFn: ({ pageParam, signal }) =>
      fetchCompanies({
        q: opts.q || undefined,
        limit: COMPANIES_PAGE_LIMIT,
        offset: pageParam,
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: companiesNextPageParam,
    staleTime: 30_000,
  })
}

export async function fetchCompany(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CompanyDetail> {
  return api.get<CompanyDetail>(`/companies/${encodeURIComponent(id)}`, {
    signal: opts.signal,
  })
}

export interface CreateCompanyInput {
  canonicalName: string
  primaryDomain?: string
}

export interface CreateCompanyResult {
  /** 201 = newly created, 409 = existing returned (normalized-name collision). */
  status: 201 | 409
  company: CompanyListItem
}

/**
 * POST /companies — create-on-the-fly without enrichment. Mirrors the
 * desktop EntityPicker's "Create '{query}'" flow. On normalized-name
 * collision (case/punctuation-insensitive) returns 409 with the
 * existing row so the caller can substitute silently.
 */
export async function createCompany(
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  const { status, body } = await apiFetchRaw('/companies', {
    method: 'POST',
    body: input,
  })
  if (status === 201 || status === 409) {
    return { status: status as 201 | 409, company: body as CompanyListItem }
  }
  throw new ApiError({
    status,
    code: `HTTP_${status}`,
    message: 'POST /companies failed',
    details: body,
  })
}

export interface UpdateCompanyPatch {
  /** User-authored note pinned to the top of the company Key Takeaways card.
   *  Null clears the note. Server trims + caps at 2000 chars. */
  keyTakeawaysUserNote?: string | null
}

export interface UpdateCompanyResult {
  id: string
  keyTakeawaysUserNote: string | null
  lamport: string
}

/**
 * PATCH /companies/:id — partial update with Lamport LWW. Caller supplies
 * a lamport string (typically `Date.now().toString()`). Currently only
 * `keyTakeawaysUserNote` is updatable from mobile.
 */
export async function updateCompany(
  id: string,
  patch: UpdateCompanyPatch,
  lamport: string,
): Promise<UpdateCompanyResult> {
  return api.patch<UpdateCompanyResult>(
    `/companies/${encodeURIComponent(id)}`,
    { ...patch, lamport },
  )
}

