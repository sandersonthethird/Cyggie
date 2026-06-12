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

// Sentinel passed as folderPath to filter unfoldered notes (folder_path IS
// NULL on the gateway). Mirrors desktop FolderSidebar.INBOX_SENTINEL.
export const NOTES_INBOX_SENTINEL = '__inbox__'

interface FetchNotesOpts {
  q?: string
  companyId?: string
  contactId?: string
  meetingId?: string
  untagged?: boolean
  folderPath?: string
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
  if (opts.folderPath) params.set('folderPath', opts.folderPath)
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

export interface UpdateNotePatch {
  /** Note title. Null/empty clears it. Server trims + caps at 500 chars. */
  title?: string | null
  /** Note body (freeform markdown). Server caps at 100k chars. */
  content?: string
}

export interface UpdateNoteResult {
  id: string
  title: string | null
  content: string
  isPinned: boolean
  lamport: string
  updatedAt: string
}

/**
 * PATCH /notes/:id — partial edit with Lamport LWW. Caller supplies a lamport
 * string (typically `Date.now().toString()`). On a stale lamport the gateway
 * responds 409 → `api.patch` throws an `ApiError` with `status === 409`, which
 * the editor surfaces as "note changed elsewhere, refresh and retry".
 */
export async function updateNote(
  id: string,
  patch: UpdateNotePatch,
  lamport: string,
): Promise<UpdateNoteResult> {
  return api.patch<UpdateNoteResult>(`/notes/${encodeURIComponent(id)}`, {
    ...patch,
    lamport,
  })
}

export interface NoteFolder {
  path: string
  count: number
}

export interface NoteFoldersResponse {
  folders: NoteFolder[]
  inboxCount: number
  totalCount: number
}

export async function fetchNoteFolders(
  opts: { signal?: AbortSignal } = {},
): Promise<NoteFoldersResponse> {
  return api.get<NoteFoldersResponse>('/note-folders', { signal: opts.signal })
}
