import { api } from './client'

// Typed client for /contacts/* gateway routes.

export interface ContactListItem {
  id: string
  fullName: string
  email: string | null
  title: string | null
  contactType: string | null
  primaryCompanyId: string | null
  primaryCompanyName: string | null
  city: string | null
  state: string | null
  lastMeetingAt: string | null
}

export interface ContactMeetingRef {
  id: string
  title: string
  date: string
  durationSeconds: number | null
}

export interface ContactDetail extends ContactListItem {
  firstName: string | null
  lastName: string | null
  phone: string | null
  linkedinUrl: string | null
  twitterHandle: string | null
  linkedinHeadline: string | null
  relationshipStrength: string | null
  investorStage: string | null
  fundSize: number | null
  typicalCheckSizeMin: number | null
  typicalCheckSizeMax: number | null
  notes: string | null
  keyTakeaways: string | null
  lastEmailAt: string | null
  recentMeetings: ContactMeetingRef[]
}

interface FetchContactsOpts {
  q?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}

interface ContactsListResponse {
  contacts: ContactListItem[]
  total: number
}

export async function fetchContacts(
  opts: FetchContactsOpts = {},
): Promise<ContactsListResponse> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.offset !== undefined) params.set('offset', String(opts.offset))
  const qs = params.toString()
  const path = qs ? `/contacts?${qs}` : '/contacts'
  return api.get<ContactsListResponse>(path, { signal: opts.signal })
}

export async function fetchContact(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ContactDetail> {
  return api.get<ContactDetail>(`/contacts/${encodeURIComponent(id)}`, {
    signal: opts.signal,
  })
}
