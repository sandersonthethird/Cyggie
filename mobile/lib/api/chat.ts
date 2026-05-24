import { api, apiFetchRaw, ApiError, GATEWAY_URL, ensureFreshAccessToken } from './client'
import { useAuthStore } from '../auth/store'
import { tick as tickLamport } from '../sync/clock'
import { createSseParser } from '../sse'

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

// ─── T18 — SSE streaming version of POST /chat/sessions/:id/messages ───────

/**
 * Discriminated error union returned via `onError` from
 * sendSessionMessageStream. Mobile UI maps each `code` to a specific
 * surface (toast, retry banner, etc.).
 */
export type ChatStreamError =
  /** fetch() itself threw — wifi drop, DNS failure, etc. */
  | { code: 'network'; message: string }
  /** Non-2xx HTTP status (e.g., 409, 413, 401, 5xx). Pre-stream error. */
  | { code: 'http'; status: number; body?: unknown }
  /** Gateway emitted `event: error` mid-stream — typed upstream failure. */
  | { code: 'gateway_error'; gatewayCode: string; message: string }
  /** Malformed SSE — shouldn't happen with our gateway but defensive. */
  | { code: 'parse'; message: string }

export interface SendSessionMessageStreamHandlers {
  /** Called for every `event: token` (one per Anthropic content_block_delta). */
  onToken: (text: string) => void
  /** Called once with the persisted final state when the stream completes
   *  successfully (gateway emitted `event: done`). */
  onDone: (result: SendSessionMessageResult) => void
  /** Called for any failure. Stream is terminated by the time this fires. */
  onError: (err: ChatStreamError) => void
}

/**
 * POST /chat/sessions/:id/messages with `Accept: text/event-stream`. Reads
 * the response body via getReader() and dispatches SSE events through
 * the provided handlers. Mints lamport via the mobile clock.
 *
 * Resolves the returned Promise after onDone OR onError has fired —
 * callers can `await` for completion / cleanup. The Promise never
 * rejects (errors go through onError) so the caller doesn't have to
 * try/catch in addition to handling onError.
 *
 * Abort: pass an AbortSignal to terminate the in-flight stream. Aborts
 * fire onError({code: 'network', message: 'Aborted'}) so the UI clears
 * pending state consistently with other failure modes.
 *
 * 401 → refresh → retry: matches the apiFetchRaw flow. One retry max.
 *
 * Auth & URL: reads the access token from the shared auth store; uses
 * the same gateway base URL as the rest of the API client.
 */
export async function sendSessionMessageStream(
  sessionId: string,
  input: SendSessionMessageInput,
  handlers: SendSessionMessageStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const lamport = tickLamport()
  const url = `${GATEWAY_URL}/chat/sessions/${encodeURIComponent(sessionId)}/messages`
  const body = JSON.stringify({ content: input.content, lamport })

  const buildHeaders = (token: string | null): Record<string, string> => {
    const h: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    }
    if (token) h['Authorization'] = `Bearer ${token}`
    return h
  }

  let token = useAuthStore.getState().accessToken
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body,
      ...(signal ? { signal } : {}),
    })
    // 401 → refresh once, retry. Mirrors apiFetchRaw.
    if (res.status === 401) {
      const fresh = await ensureFreshAccessToken()
      if (fresh) {
        token = fresh
        res = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(token),
          body,
          ...(signal ? { signal } : {}),
        })
      }
    }
  } catch (err) {
    handlers.onError({
      code: 'network',
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (!res.ok) {
    // Pre-stream rejection (409 lamport, 413 oversize, 4xx, 5xx). The
    // body is JSON-shaped {error: {...}} for most failures.
    const parsedBody = await res
      .clone()
      .json()
      .catch(() => res.text().catch(() => null))
    handlers.onError({ code: 'http', status: res.status, body: parsedBody ?? undefined })
    return
  }

  if (!res.body) {
    // Some RN polyfills don't expose body — fall back to a parse error.
    handlers.onError({
      code: 'parse',
      message: 'Response has no readable body — streaming not supported here.',
    })
    return
  }

  // Stream-read + parse loop.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let gatewayErrorFired = false
  let doneFired = false

  const parser = createSseParser((ev) => {
    if (ev.event === 'token') {
      try {
        const data = JSON.parse(ev.data) as { text?: string }
        if (typeof data.text === 'string') handlers.onToken(data.text)
      } catch {
        // Bad token event — skip; the gateway never sends these but be defensive.
      }
    } else if (ev.event === 'done') {
      try {
        const data = JSON.parse(ev.data) as Omit<SendSessionMessageResult, 'ok'>
        doneFired = true
        handlers.onDone({ ok: true, ...data })
      } catch (err) {
        handlers.onError({
          code: 'parse',
          message: err instanceof Error ? err.message : 'Bad done payload',
        })
      }
    } else if (ev.event === 'error') {
      try {
        const data = JSON.parse(ev.data) as { code?: string; message?: string }
        gatewayErrorFired = true
        handlers.onError({
          code: 'gateway_error',
          gatewayCode: data.code ?? 'UNKNOWN',
          message: data.message ?? 'Upstream error',
        })
      } catch {
        gatewayErrorFired = true
        handlers.onError({
          code: 'gateway_error',
          gatewayCode: 'UNKNOWN',
          message: 'Gateway reported an unparseable error',
        })
      }
    }
    // Unknown event types are silently ignored per SSE spec.
  })

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parser(decoder.decode(value, { stream: true }))
    }
    parser('', true) // flush any tail without trailing newline
  } catch (err) {
    if (!doneFired && !gatewayErrorFired) {
      handlers.onError({
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  // Stream closed cleanly with no done/error event — treat as abort.
  // Don't fire onError if the abort was the cause (caller's choice);
  // also don't fire if done/error already fired.
  if (!doneFired && !gatewayErrorFired) {
    handlers.onError({
      code: 'network',
      message: 'Stream ended without a done or error event.',
    })
  }
}
