import { api } from './client'

// Typed client for /notes/* gateway routes.

export interface NoteListItem {
  id: string
  title: string | null
  contentPreview: string
  isPinned: boolean
  companyId: string | null
  companyName: string | null
  contactId: string | null
  contactName: string | null
  sourceMeetingId: string | null
  folderPath: string | null
  importSource: string | null
  updatedAt: string
}

export interface NoteDetail extends NoteListItem {
  content: string
  sourceMeetingTitle: string | null
  createdAt: string
}

interface FetchNotesOpts {
  q?: string
  companyId?: string
  contactId?: string
  meetingId?: string
  untagged?: boolean
  limit?: number
  offset?: number
  signal?: AbortSignal
}

interface NotesListResponse {
  notes: NoteListItem[]
  total: number
}

export async function fetchNotes(
  opts: FetchNotesOpts = {},
): Promise<NotesListResponse> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.companyId) params.set('companyId', opts.companyId)
  if (opts.contactId) params.set('contactId', opts.contactId)
  if (opts.meetingId) params.set('meetingId', opts.meetingId)
  if (opts.untagged) params.set('untagged', 'true')
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.offset !== undefined) params.set('offset', String(opts.offset))
  const qs = params.toString()
  const path = qs ? `/notes?${qs}` : '/notes'
  return api.get<NotesListResponse>(path, { signal: opts.signal })
}

export async function fetchNote(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<NoteDetail> {
  return api.get<NoteDetail>(`/notes/${encodeURIComponent(id)}`, {
    signal: opts.signal,
  })
}
