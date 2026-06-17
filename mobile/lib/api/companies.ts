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

interface CompaniesListResponse {
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

