import { api } from './client'

// Typed client for the /search fan-out endpoint.

export interface CompanyHit {
  id: string
  name: string
  industry: string | null
  pipelineStage: string | null
  primaryDomain: string | null
}

export interface ContactHit {
  id: string
  fullName: string
  title: string | null
  email: string | null
  primaryCompanyName: string | null
  primaryCompanyDomain: string | null
}

export interface MeetingHit {
  id: string
  title: string
  date: string
  durationSeconds: number | null
}

export interface NoteHit {
  id: string
  title: string | null
  contentPreview: string
  companyName: string | null
  contactName: string | null
  updatedAt: string
}

export interface SearchResponse {
  query: string
  companies: { items: CompanyHit[]; total: number }
  contacts: { items: ContactHit[]; total: number }
  meetings: { items: MeetingHit[]; total: number }
  notes: { items: NoteHit[]; total: number }
}

export async function searchEverything(
  q: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q })
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  return api.get<SearchResponse>(`/search?${params.toString()}`, {
    signal: opts.signal,
  })
}
