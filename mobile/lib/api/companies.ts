import { api } from './client'

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
  primaryDomain: string | null
  websiteUrl: string | null
  linkedinCompanyUrl: string | null
  employeeCountRange: string | null
  foundingYear: number | null
  arr: number | null
  runwayMonths: number | null
  round: string | null
  raiseSize: number | null
  totalFundingRaised: number | null
  recentMeetings: CompanyMeetingRef[]
  people: CompanyPersonRef[]
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
