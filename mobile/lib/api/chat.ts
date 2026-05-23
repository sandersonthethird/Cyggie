import { api, apiFetchRaw, ApiError } from './client'
import { tick as tickLamport } from '../sync/clock'

// Chat API client. Gateway contract (T17a A1–A4 + 2026-05-23 cleanup):
//   POST /chat/sessions                       — find-or-create session
//   GET  /chat/sessions                       — paginated list
//   GET  /chat/sessions/:id                   — session + messages
//   PATCH /chat/sessions/:id                  — rename / pin / archive (OCC)
//   POST /chat/sessions/:id/messages          — append user turn, run LLM,
//                                                persist both turns
//
// The legacy stateless POST /chat/messages route was removed 2026-05-23
// (T18+T19 plan, Issue 2A). All chat now flows through the session route.
//
// T17b mobile binds these into the persistent chat surfaces (per-entity
// chat from detail screens + repurposed global Chat tab). Lamports are
// minted via the shared mobile sync clock so they share monotonic
// ordering with notes-edit and other mobile write paths.

// ─── Shared wire types ─────────────────────────────────────────────────────

export type ChatContextKind =
  | 'meeting'
  | 'company'
  | 'contact'
  | 'search-results'
  | 'crm'

export interface ChatSessionListItem {
  id: string
  contextId: string
  contextKind: string
  contextLabel: string | null
  title: string | null
  previewText: string | null
  messageCount: number
  isPinned: boolean
  isArchived: boolean
  isActive: boolean
  lastMessageAt: string
  updatedAt: string
  lamport: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations: unknown | null
  attachmentsJson: unknown | null
  createdAt: string
  lamport: string
}

export interface ChatSessionDetail {
  session: ChatSessionListItem
  messages: ChatMessage[]
}

// ─── T17b — session-backed chat ────────────────────────────────────────────

export interface ListChatSessionsParams {
  contextKind?: ChatContextKind
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export interface ListChatSessionsResult {
  sessions: ChatSessionListItem[]
  total: number
}

/** GET /chat/sessions — paginated list. Defaults match the gateway. */
export function fetchChatSessions(
  params: ListChatSessionsParams = {},
  opts?: { signal?: AbortSignal },
): Promise<ListChatSessionsResult> {
  const qs = new URLSearchParams()
  if (params.contextKind) qs.set('contextKind', params.contextKind)
  if (params.includeArchived) qs.set('includeArchived', 'true')
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.offset !== undefined) qs.set('offset', String(params.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return api.get<ListChatSessionsResult>(`/chat/sessions${suffix}`, opts)
}

/** GET /chat/sessions/:id — session + chronological messages. */
export function fetchChatSession(
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<ChatSessionDetail> {
  return api.get<ChatSessionDetail>(`/chat/sessions/${encodeURIComponent(sessionId)}`, opts)
}

export interface CreateChatSessionInput {
  contextKind: ChatContextKind
  contextId: string
  contextLabel?: string | null
}

/**
 * POST /chat/sessions — idempotent find-or-create. Returns the existing
 * active session for (user, contextId) if one exists (200) or creates a
 * fresh one (201). The HTTP status difference is intentional but mobile
 * doesn't usually need to distinguish — both bodies are the same
 * `ChatSessionListItem` shape, so the caller just gets a session back.
 */
export function createOrGetChatSession(
  input: CreateChatSessionInput,
): Promise<ChatSessionListItem> {
  return api.post<ChatSessionListItem>('/chat/sessions', input)
}

export interface UpdateChatSessionInput {
  title?: string
  isPinned?: boolean
  isArchived?: boolean
}

export interface UpdateChatSessionResult {
  ok: boolean
  session?: ChatSessionListItem
  /** Server's current state when our PATCH conflicted (409). Caller should
   * reconcile by refetching + retrying with the fresh lamport. */
  conflict?: ChatSessionListItem
}

/**
 * PATCH /chat/sessions/:id — rename / pin / archive. Mints a fresh
 * lamport via the mobile clock; on 409 returns the server's current
 * session so the caller can reconcile (mirrors the notes-edit 409 flow).
 *
 * Uses `apiFetchRaw` because the gateway's 409 path replies with a raw
 * `ChatSessionListItem` body, not the `{error: {...}}` envelope that
 * `api.patch` expects.
 */
export async function updateChatSession(
  sessionId: string,
  input: UpdateChatSessionInput,
): Promise<UpdateChatSessionResult> {
  const lamport = tickLamport()
  const { status, body } = await apiFetchRaw(
    `/chat/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'PATCH', body: { ...input, lamport } },
  )
  if (status === 200) {
    return { ok: true, session: body as ChatSessionListItem }
  }
  if (status === 409) {
    return { ok: false, conflict: body as ChatSessionListItem }
  }
  throw new ApiError({
    status,
    code: `HTTP_${status}`,
    message: `PATCH /chat/sessions/${sessionId} failed`,
    details: body,
  })
}

export interface SendSessionMessageInput {
  content: string
}

export interface SendSessionMessageResult {
  ok: true
  session: ChatSessionListItem
  userMessage: ChatMessage
  assistantMessage: ChatMessage
}

export interface SendSessionMessageConflict {
  ok: false
  conflict: ChatSessionDetail
}

/**
 * POST /chat/sessions/:id/messages — appends a user turn, runs the LLM
 * (gateway-side contextKind-aware context builder), persists both turns.
 * Mints lamport via the mobile clock.
 *
 * 409: server returns the full {session, messages} so the caller can
 * reconcile with whatever raced in from another device.
 *
 * Uses `apiFetchRaw` for the same 409-body reason as updateChatSession.
 */
export async function sendSessionMessage(
  sessionId: string,
  input: SendSessionMessageInput,
): Promise<SendSessionMessageResult | SendSessionMessageConflict> {
  const lamport = tickLamport()
  const { status, body } = await apiFetchRaw(
    `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    { method: 'POST', body: { content: input.content, lamport } },
  )
  if (status === 200) {
    const r = body as Omit<SendSessionMessageResult, 'ok'>
    return { ok: true, session: r.session, userMessage: r.userMessage, assistantMessage: r.assistantMessage }
  }
  if (status === 409) {
    return { ok: false, conflict: body as ChatSessionDetail }
  }
  throw new ApiError({
    status,
    code: `HTTP_${status}`,
    message: `POST /chat/sessions/${sessionId}/messages failed`,
    details: body,
  })
}
