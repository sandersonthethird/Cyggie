import { api } from './client'

// Typed client for /notes/* gateway routes.

export interface NoteListItem {
  id: string
  title: string | null
  contentPreview: string
  isPinned: boolean
  /** True = visible only to the author; false = firm-visible when tagged. */
  isPrivate: boolean
  /** Owner of the note. The note is "mine" iff this === my user id. */
  authorUserId: string
  /** Owner's display name (for "Shared by …" on a teammate's note). */
  authorName: string | null
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
  /**
   * Narrow by visibility. 'private' = my own owner-only notes (is_private);
   * 'shared' = firm-visible notes (tagged & not private), incl. teammates'.
   */
  visibility?: 'private' | 'shared'
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
  if (opts.visibility) params.set('visibility', opts.visibility)
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
  /** Privacy toggle. Owner-only on the server (scoped by note owner). */
  isPrivate?: boolean
  /** Company tag. Null clears it. Tagging makes a non-private note firm-visible. */
  companyId?: string | null
  /** Contact tag. Null clears it. */
  contactId?: string | null
}

/**
 * PATCH /notes/:id — partial edit with Lamport LWW. Caller supplies a lamport
 * string (typically `Date.now().toString()`). On a stale lamport the gateway
 * responds 409 → `api.patch` throws an `ApiError` with `status === 409`, which
 * the editor surfaces as "note changed elsewhere, refresh and retry".
 *
 * Returns the full NoteDetail (server-truth company/contact names) so the caller
 * can seed its cache directly — no client-side name merging.
 */
export async function updateNote(
  id: string,
  patch: UpdateNotePatch,
  lamport: string,
): Promise<NoteDetail> {
  return api.patch<NoteDetail>(`/notes/${encodeURIComponent(id)}`, {
    ...patch,
    lamport,
  })
}

export interface CreateNoteInput {
  title?: string | null
  content?: string
  folderPath?: string | null
  isPrivate?: boolean
  companyId?: string | null
  contactId?: string | null
}

/**
 * POST /notes — create a note. Caller supplies a lamport (typically
 * `Date.now().toString()`). Returns the full NoteDetail so the caller can seed
 * the detail cache and open the editor without a follow-up GET.
 */
export async function createNote(
  input: CreateNoteInput,
  lamport: string,
): Promise<NoteDetail> {
  return api.post<NoteDetail>('/notes', { ...input, lamport })
}

/**
 * DELETE /notes/:id. Default = soft delete (sets deleted_at, replicates the
 * deletion cross-device). `hard: true` hard-deletes — used only to clean up an
 * abandoned empty note the editor just created (no replication needed, avoids a
 * permanent soft-deleted junk row).
 */
export async function deleteNote(
  id: string,
  opts: { hard?: boolean } = {},
): Promise<void> {
  const qs = opts.hard ? '?hard=true' : ''
  await api.delete<{ ok: true }>(`/notes/${encodeURIComponent(id)}${qs}`)
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
