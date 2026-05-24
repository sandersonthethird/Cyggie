import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { resolveAnthropicKey, toGatewayErrorIfAnthropic } from '../llm/resolve-key'
import { validateClientLamport } from '../sync/validate-lamport'
import {
  TRANSCRIPT_CONTEXT_BUDGET,
  flattenSegments,
  truncateTranscript,
} from '../llm/transcript-flatten'
import {
  CHAT_HISTORY_CHAR_BUDGET,
  truncateHistoryByChars,
} from '../llm/truncate-history'

// ─── Shared schemas (T17a A2: sessions list/detail/PATCH) ────────────────────

const CHAT_CONTEXT_KINDS = ['meeting', 'company', 'contact', 'search-results', 'crm'] as const

const ChatSessionListItemSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  contextKind: z.string(),
  contextLabel: z.string().nullable(),
  title: z.string().nullable(),
  previewText: z.string().nullable(),
  messageCount: z.number(),
  isPinned: z.boolean(),
  isArchived: z.boolean(),
  isActive: z.boolean(),
  lastMessageAt: z.string(),
  updatedAt: z.string(),
  lamport: z.string(),
  // Phase 2: per-session selected company context (Ask Cyggie tab only).
  // Default [] for sessions created before Phase 2 + for non-crm contexts.
  selectedCompanyIds: z.array(z.string()).default([]),
})

const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  citations: z.unknown().nullable(),
  attachmentsJson: z.unknown().nullable(),
  createdAt: z.string(),
  lamport: z.string(),
})

// Phase 2: hydrated chip shape returned alongside ChatSessionDetail. The
// gateway's GET /chat/sessions/:id handler joins org_companies on
// session.selectedCompanyIds so the mobile pill row can render chips with
// names/industry/stage without a separate per-id round-trip. Stale IDs
// (company deleted between selection and fetch) are silently filtered.
const CompanyChipSchema = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string().nullable(),
  stage: z.string().nullable(),
})

const ChatSessionDetailSchema = z.object({
  session: ChatSessionListItemSchema,
  messages: z.array(ChatMessageSchema),
  selectedCompanies: z.array(CompanyChipSchema).default([]),
})

// Drizzle's `integer` column returns number; the wire shape is boolean for
// is_pinned / is_archived / is_active. Single source of truth for the
// row→DTO mapping is `serializeSession`.
type SessionRow = typeof schema.chatSessions.$inferSelect
type MessageRow = typeof schema.chatSessionMessages.$inferSelect

function serializeSession(row: SessionRow): z.infer<typeof ChatSessionListItemSchema> {
  return {
    id: row.id,
    contextId: row.contextId,
    contextKind: row.contextKind,
    contextLabel: row.contextLabel,
    title: row.title,
    previewText: row.previewText,
    messageCount: row.messageCount,
    isPinned: row.isPinned === 1,
    isArchived: row.isArchived === 1,
    isActive: row.isActive === 1,
    lastMessageAt: row.lastMessageAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lamport: row.lamport,
    // Default-array fallback covers the brief migration window where
    // existing rows haven't been backfilled yet (Postgres column default
    // is '[]'::jsonb, so this should never actually fire — defensive).
    selectedCompanyIds: row.selectedCompanyIds ?? [],
  }
}

function serializeMessage(row: MessageRow): z.infer<typeof ChatMessageSchema> {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    citations: row.citations ?? null,
    attachmentsJson: row.attachmentsJson ?? null,
    createdAt: row.createdAt.toISOString(),
    lamport: row.lamport,
  }
}

// =============================================================================
// /chat routes — session-backed multi-turn chat with Cyggie context.
//
// The legacy stateless POST /chat/messages route was removed 2026-05-23
// (T18+T19 plan). All chat now flows through the session route
// (POST /chat/sessions/:id/messages) which persists conversation
// history in chat_session_messages, loads prior turns into the Claude
// context, and (post-T18) streams the reply via SSE.
//
// Routes registered here:
//   • GET    /chat/sessions               — list paginated user sessions
//   • GET    /chat/sessions/:id           — session + chronological messages
//   • POST   /chat/sessions               — find-or-create active session
//   • PATCH  /chat/sessions/:id           — rename / pin / archive (OCC)
//   • POST   /chat/sessions/:id/messages  — append user turn, run LLM,
//                                            persist both turns
//
// Removed (2026-05-23):
//   • POST /chat/messages — stateless one-shot, no callers after T17b.
//   • POST /chat/enhance-notes — orphan; Enhance lives at
//     POST /meetings/:id/enhance instead.
// =============================================================================

export async function registerChatRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ─────────────────────────────────────────────────────────────────────────
  // T17a A2 — chat session list / detail / PATCH endpoints.
  // ─────────────────────────────────────────────────────────────────────────

  // GET /chat/sessions — paginated list of the user's chat sessions.
  // Default sort: pinned DESC, lastMessageAt DESC.
  // Filter: contextKind (optional), includeArchived (default false).
  fastifyTyped.route({
    method: 'GET',
    url: '/chat/sessions',
    schema: {
      querystring: z.object({
        contextKind: z.enum(CHAT_CONTEXT_KINDS).optional(),
        includeArchived: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      response: {
        200: z.object({
          sessions: z.array(ChatSessionListItemSchema),
          total: z.number(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { contextKind, includeArchived, limit, offset } = req.query

      const where = [eq(schema.chatSessions.userId, user.sub)]
      if (contextKind) {
        where.push(eq(schema.chatSessions.contextKind, contextKind))
      }
      if (!includeArchived) {
        where.push(eq(schema.chatSessions.isArchived, 0))
      }

      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(schema.chatSessions)
          .where(and(...where))
          .orderBy(desc(schema.chatSessions.isPinned), desc(schema.chatSessions.lastMessageAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.chatSessions)
          .where(and(...where)),
      ])

      return {
        sessions: rows.map(serializeSession),
        total: totalRows[0]?.count ?? 0,
      }
    },
  })

  // GET /chat/sessions/:id — single session + its messages (oldest first).
  // 404 (not 403) on wrong-user so we don't leak existence.
  fastifyTyped.route({
    method: 'GET',
    url: '/chat/sessions/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: ChatSessionDetailSchema },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params

      const session = await db.query.chatSessions.findFirst({
        where: and(
          eq(schema.chatSessions.id, id),
          eq(schema.chatSessions.userId, user.sub),
        ),
      })
      if (!session) {
        throw new GatewayError({
          statusCode: 404,
          code: 'CHAT_SESSION_NOT_FOUND',
          message: 'Chat session not found.',
        })
      }

      const messages = await db
        .select()
        .from(schema.chatSessionMessages)
        .where(eq(schema.chatSessionMessages.sessionId, id))
        .orderBy(asc(schema.chatSessionMessages.createdAt))

      // Phase 2: hydrate selected_company_ids into chips so the mobile
      // pill row can render without per-id round-trips. Stale IDs
      // (company deleted between selection and fetch) are silently
      // dropped — they just don't appear in the result.
      const selectedCompanies = await hydrateSelectedCompanies(
        db,
        session.selectedCompanyIds ?? [],
        user.sub,
      )

      return {
        session: serializeSession(session),
        messages: messages.map(serializeMessage),
        selectedCompanies,
      }
    },
  })

  // PATCH /chat/sessions/:id — partial update (title / isPinned / isArchived / selectedCompanyIds).
  // Lamport LWW: same pattern as PATCH /meetings/:id. Body's lamport must be
  // strictly greater than the stored one or we 409 with the current state so
  // the client can reconcile.
  fastifyTyped.route({
    method: 'PATCH',
    url: '/chat/sessions/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      body: z.object({
        title: z.string().min(1).max(200).optional(),
        isPinned: z.boolean().optional(),
        isArchived: z.boolean().optional(),
        // Phase 2: replaces the entire selected-companies list (not a delta).
        // Mobile picker emits the final array on Done; gateway stores as-is.
        // Element IDs are NOT validated against org_companies here — stale
        // IDs are filtered downstream when buildSelectedCompaniesContext
        // joins (Phase 2 silently-filter-stale policy).
        selectedCompanyIds: z.array(z.string()).optional(),
        lamport: z.string().min(1).max(40),
      }),
      response: { 200: ChatSessionListItemSchema, 409: ChatSessionListItemSchema },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params
      const body = req.body

      // T8 — incoming lamport ceiling check (mirrors PATCH /meetings/:id).
      const lamportCheck = validateClientLamport(body.lamport)
      if (!lamportCheck.valid) {
        req.log.warn(
          {
            sessionId: id,
            userId: user.sub,
            incoming: body.lamport,
            reason: lamportCheck.reason,
            metric: 'chat.sessions.patch.lamport_rejected',
          },
          'patch rejected: lamport out of range',
        )
        throw new GatewayError({
          statusCode: 400,
          code: 'LAMPORT_OUT_OF_RANGE',
          message:
            lamportCheck.reason === 'unparseable'
              ? 'lamport is not a valid integer'
              : 'lamport is too far in the future',
        })
      }

      const session = await db.query.chatSessions.findFirst({
        where: and(
          eq(schema.chatSessions.id, id),
          eq(schema.chatSessions.userId, user.sub),
        ),
      })
      if (!session) {
        // 404 — don't leak existence of sessions owned by other users.
        throw new GatewayError({
          statusCode: 404,
          code: 'CHAT_SESSION_NOT_FOUND',
          message: 'Chat session not found.',
        })
      }

      // Lamport LWW compare (matches sync.ts + meetings PATCH).
      const incoming = lamportCheck.bigint
      const stored = BigInt(session.lamport ?? '0')
      if (incoming <= stored) {
        req.log.info(
          {
            sessionId: id,
            userId: user.sub,
            incoming: body.lamport,
            stored: session.lamport,
            metric: 'chat.sessions.patch.conflict_409',
          },
          'patch rejected: lamport not strictly greater than stored',
        )
        return reply.code(409).send(serializeSession(session))
      }

      // Build the partial update set. At least one body field besides lamport
      // must be provided; the zod schema doesn't enforce that, so refuse here
      // — preserves the "PATCH = intentional change" semantics.
      const updates: Partial<typeof schema.chatSessions.$inferInsert> = {
        lamport: body.lamport,
        updatedAt: new Date(),
        updatedByUserId: user.sub,
      }
      let hasField = false
      if (body.title !== undefined) {
        updates.title = body.title
        hasField = true
      }
      if (body.isPinned !== undefined) {
        updates.isPinned = body.isPinned ? 1 : 0
        hasField = true
      }
      if (body.isArchived !== undefined) {
        updates.isArchived = body.isArchived ? 1 : 0
        // Archiving an active session implicitly deactivates it so the
        // unique active-per-context index doesn't block future chats.
        if (body.isArchived) updates.isActive = 0
        hasField = true
      }
      if (body.selectedCompanyIds !== undefined) {
        updates.selectedCompanyIds = body.selectedCompanyIds
        hasField = true
      }
      if (!hasField) {
        throw new GatewayError({
          statusCode: 400,
          code: 'CHAT_SESSION_PATCH_EMPTY',
          message: 'PATCH must include at least one of: title, isPinned, isArchived, selectedCompanyIds.',
        })
      }

      const [updated] = await db
        .update(schema.chatSessions)
        .set(updates)
        .where(eq(schema.chatSessions.id, id))
        .returning()

      req.log.info(
        {
          sessionId: id,
          userId: user.sub,
          metric: 'chat.sessions.patch.success',
          changed: Object.keys(updates),
        },
        'chat session patched',
      )

      return serializeSession(updated)
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // T17a A4 — POST /chat/sessions: idempotent find-or-create.
  //
  // Mobile/desktop want to "open the chat for this company/meeting/contact".
  // We invariant-keep at most one ACTIVE session per contextId (enforced by
  // the chat_sessions_active_idx unique partial index). This handler:
  //   1. Looks for an active session for (userId, contextId).
  //   2. Returns it if found (200).
  //   3. Otherwise inserts a new one (201).
  // Race protection: ON CONFLICT DO NOTHING on the unique index, then
  // re-SELECT in case a concurrent request beat us to it.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/chat/sessions',
    schema: {
      body: z.object({
        contextKind: z.enum(CHAT_CONTEXT_KINDS),
        contextId: z.string().min(1).max(128),
        contextLabel: z.string().max(200).nullable().optional(),
      }),
      response: {
        200: ChatSessionListItemSchema,
        201: ChatSessionListItemSchema,
      },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { contextKind, contextId, contextLabel } = req.body

      // Step 1: look for an existing active session for (user, contextId).
      const existing = await db
        .select()
        .from(schema.chatSessions)
        .where(
          and(
            eq(schema.chatSessions.userId, user.sub),
            eq(schema.chatSessions.contextId, contextId),
            eq(schema.chatSessions.isActive, 1),
          ),
        )
        .limit(1)

      if (existing[0]) {
        req.log.info(
          {
            metric: 'chat.sessions.foc.hit',
            userId: user.sub,
            sessionId: existing[0].id,
            contextKind,
          },
          'session find-or-create: existing returned',
        )
        return reply.code(200).send(serializeSession(existing[0]))
      }

      // Step 2: insert a new active session. Server-mint lamport using the
      // same max-of-stored-or-wallclock pattern as POST /meetings/:id/enhance.
      const nowMs = Date.now()
      const lamport = (BigInt(nowMs) + 1n).toString()
      const id = createId()

      try {
        const [inserted] = await db
          .insert(schema.chatSessions)
          .values({
            id,
            userId: user.sub,
            contextId,
            contextKind,
            contextLabel: contextLabel ?? null,
            title: null,
            previewText: null,
            messageCount: 0,
            isActive: 1,
            isPinned: 0,
            isArchived: 0,
            lastMessageAt: new Date(nowMs),
            createdByUserId: user.sub,
            lamport,
          })
          .onConflictDoNothing({ target: schema.chatSessions.id })
          .returning()

        if (inserted) {
          req.log.info(
            {
              metric: 'chat.sessions.foc.created',
              userId: user.sub,
              sessionId: id,
              contextKind,
            },
            'session find-or-create: new session created',
          )
          return reply.code(201).send(serializeSession(inserted))
        }
      } catch (err) {
        // Unique-constraint violation can fire from the
        // chat_sessions_active_idx (only one active session per contextId)
        // when a concurrent request beats us to it. Fall through to the
        // re-SELECT below — if that finds a row, return it; otherwise
        // surface a real 500.
        const errCode = (err as { code?: string }).code
        if (errCode !== '23505') {
          req.log.error(
            { err, userId: user.sub, contextId },
            'session find-or-create: unexpected insert error',
          )
          throw new GatewayError({
            statusCode: 500,
            code: 'INTERNAL_ERROR',
            message: 'Failed to create chat session',
          })
        }
        req.log.info(
          { userId: user.sub, contextId, contextKind },
          'session find-or-create: 23505 race detected, re-selecting',
        )
      }

      // Step 3: concurrent-create race — another request inserted in between
      // our SELECT and our INSERT. Re-SELECT and return that row.
      const racedRows = await db
        .select()
        .from(schema.chatSessions)
        .where(
          and(
            eq(schema.chatSessions.userId, user.sub),
            eq(schema.chatSessions.contextId, contextId),
            eq(schema.chatSessions.isActive, 1),
          ),
        )
        .limit(1)
      if (racedRows[0]) {
        return reply.code(200).send(serializeSession(racedRows[0]))
      }

      // Truly unexpected — INSERT didn't return a row AND no active session
      // exists. Surface as 500 so we notice.
      req.log.error(
        { userId: user.sub, contextId, contextKind },
        'session find-or-create: insert silently dropped + no race winner',
      )
      throw new GatewayError({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Failed to create chat session',
      })
    },
  })

  // ─────────────────────────────────────────────────────────────────────────
  // T17a A3 — POST /chat/sessions/:id/messages: append a user message,
  // call Claude with multi-turn history + contextKind-aware context,
  // persist both messages + bump session metadata.
  //
  // Lamport semantics:
  //   - body.lamport is the CLIENT-MINTED clock for the user message.
  //     Validated against the T8 ceiling + must be strictly > session.lamport.
  //   - The assistant message + the session bump are SERVER-MINTED at
  //     max(userLamport, Date.now()) + 1.
  //
  // Multi-turn: passes the full existing chronological message history
  // to Claude. Pagination/budget management deferred to T19.
  //
  // 60s server-side AbortSignal mirrors POST /meetings/:id/enhance.
  // ─────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/chat/sessions/:id/messages',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      body: z.object({
        // T19 — content cap is a generous safety against pathological
        // megabyte-sized pastes; the actual user-facing cap is
        // CHAT_HISTORY_CHAR_BUDGET (120k chars), enforced below with a
        // typed CHAT_INPUT_TOO_LARGE 413 so mobile can surface a clean
        // "Message too large" message.
        content: z.string().min(1).max(200_000),
        lamport: z.string(),
      }),
      response: {
        200: z.object({
          session: ChatSessionListItemSchema,
          userMessage: ChatMessageSchema,
          assistantMessage: ChatMessageSchema,
        }),
        409: ChatSessionDetailSchema,
      },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params
      const { content, lamport: clientLamport } = req.body
      const startedAtMs = Date.now()

      // T8 lamport ceiling check (same as PATCH /meetings/:id).
      const lamportCheck = validateClientLamport(clientLamport)
      if (!lamportCheck.valid) {
        throw new GatewayError({
          statusCode: 400,
          code: 'LAMPORT_OUT_OF_RANGE',
          message:
            lamportCheck.reason === 'unparseable'
              ? 'lamport is not a valid integer'
              : 'lamport is too far in the future',
        })
      }

      // T19 / Issue 1A — Oversize pre-check. If the current user message
      // alone exceeds the history budget, no amount of history truncation
      // can rescue the prompt. Reject with a typed 413 BEFORE any DB I/O,
      // ownership lookup, or Anthropic call. Mobile surfaces this as
      // "Message too large to send."
      if (content.length > CHAT_HISTORY_CHAR_BUDGET) {
        throw new GatewayError({
          statusCode: 413,
          code: 'CHAT_INPUT_TOO_LARGE',
          message: 'Message too large to send.',
        })
      }

      // Fetch session, ownership filter (404 not 403 to avoid existence leak).
      const session = await db.query.chatSessions.findFirst({
        where: and(
          eq(schema.chatSessions.id, id),
          eq(schema.chatSessions.userId, user.sub),
        ),
      })
      if (!session) {
        throw new GatewayError({
          statusCode: 404,
          code: 'CHAT_SESSION_NOT_FOUND',
          message: 'Chat session not found',
        })
      }

      // LWW: incoming lamport must be strictly > session lamport. Else 409
      // with the full session+messages body so client can reconcile.
      const incomingLamport = lamportCheck.bigint
      const storedLamport = BigInt(session.lamport ?? '0')
      if (incomingLamport <= storedLamport) {
        const messages = await db
          .select()
          .from(schema.chatSessionMessages)
          .where(eq(schema.chatSessionMessages.sessionId, session.id))
          .orderBy(asc(schema.chatSessionMessages.createdAt))
        req.log.info(
          {
            metric: 'chat.sessions.append.conflict_409',
            sessionId: id,
            userId: user.sub,
          },
          'message append: lamport conflict',
        )
        return reply.code(409).send({
          session: serializeSession(session),
          messages: messages.map(serializeMessage),
        })
      }

      const apiKey = await resolveAnthropicKey(env, user.sub)
      if (!apiKey) {
        throw new GatewayError({
          statusCode: 503,
          code: 'CHAT_UNAVAILABLE',
          message:
            'No Anthropic API key configured. Set one in desktop Settings → AI & Transcription.',
        })
      }

      // Load existing message history (chronological) for multi-turn prompt.
      const historyRows = await db
        .select()
        .from(schema.chatSessionMessages)
        .where(eq(schema.chatSessionMessages.sessionId, session.id))
        .orderBy(asc(schema.chatSessionMessages.createdAt))

      // Build contextKind-aware system context. Falls back to no context
      // for kinds we don't have specialized builders for (search-results,
      // crm) — the conversation itself + session.contextLabel provide
      // enough grounding for those flavors.
      const contextBlock = await buildContextForSession(db, session)
      // Phase 2.5: segmented system prompt — base + (optional) context
      // segment with cache_control. See buildChatSessionSystemSegments.
      const systemPrompt = buildChatSessionSystemSegments(contextBlock)

      // Compose Claude messages: history + new user message.
      const rawClaudeMessages: Anthropic.MessageParam[] = historyRows
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      rawClaudeMessages.push({ role: 'user', content })

      // T19 — Trim history if the combined prompt is over the char budget.
      // Drops oldest user/assistant pairs from the front, never the current
      // user message. The oversize pre-check above guarantees we never hit
      // the helper's "only one message and it's still too big" edge case.
      const claudeMessages = truncateHistoryByChars(rawClaudeMessages, CHAT_HISTORY_CHAR_BUDGET)
      const truncatedTurns = rawClaudeMessages.length - claudeMessages.length

      // 60s server-side timeout mirrors POST /meetings/:id/enhance.
      const abortController = new AbortController()
      const timeoutHandle = setTimeout(() => abortController.abort(), 60_000)

      req.log.info(
        {
          metric: 'chat.sessions.append.start',
          sessionId: id,
          userId: user.sub,
          contextKind: session.contextKind,
          historyLength: historyRows.length,
          truncatedTurns,
        },
        truncatedTurns > 0 ? 'message append: start (history truncated)' : 'message append: start',
      )

      const client = new Anthropic({ apiKey })

      // ─── Branch: streaming vs blocking ────────────────────────────────
      //
      // Streaming opt-in: client sends `Accept: text/event-stream` (cleaner
      // than a `?stream=1` query param; mirrors the SSE convention). Without
      // the header, the blocking path runs unchanged (bit-for-bit identical
      // wire format to the pre-T18 behavior).
      const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream')

      if (wantsStream) {
        // STREAM PATH — write SSE response.
        //
        // reply.hijack() disables Fastify's auto-response machinery so our
        // raw writes don't conflict with a duplicate response Fastify would
        // otherwise emit after the handler returns. Without this, every
        // streaming response ends with "ERR_HTTP_HEADERS_SENT" or a hung
        // client.
        //
        // Anti-buffering headers: required so fly-proxy + any intermediary
        // forwards bytes immediately rather than buffering until the response
        // ends. Without these, the streaming "works" locally but tokens
        // arrive in one chunk in production. flushHeaders() forces the
        // headers out before the first token.
        reply.hijack()
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        })
        reply.raw.flushHeaders()

        let assembledText = ''
        try {
          const stream = client.messages.stream(
            {
              model: 'claude-sonnet-4-5-20250929',
              max_tokens: 2048,
              system: systemPrompt,
              messages: claudeMessages,
            },
            { signal: abortController.signal },
          )
          for await (const event of stream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              const deltaText = event.delta.text
              assembledText += deltaText
              reply.raw.write(
                `event: token\ndata: ${JSON.stringify({ text: deltaText })}\n\n`,
              )
            }
          }
          // Drain to ensure stream.finalMessage() returns the final usage.
          await stream.finalMessage()
        } catch (err) {
          clearTimeout(timeoutHandle)
          // Abort: client navigated away or 60s timer fired. No DB writes,
          // no done event — just close the stream cleanly.
          if (err instanceof Anthropic.APIUserAbortError) {
            req.log.info(
              {
                metric: 'chat.sessions.append.abort',
                sessionId: id,
                userId: user.sub,
                duration_ms: Date.now() - startedAtMs,
                tokensSoFar: assembledText.length,
              },
              'message append: stream aborted',
            )
            reply.raw.end()
            return reply
          }
          // Other Anthropic / network error: emit error event + close.
          const gw = toGatewayErrorIfAnthropic(err)
          const code = gw?.code ?? 'CHAT_STREAM_ERROR'
          const message = gw?.message ?? 'Streaming failed'
          req.log.warn(
            {
              metric: 'chat.sessions.append.error',
              sessionId: id,
              userId: user.sub,
              duration_ms: Date.now() - startedAtMs,
              errCode: code,
              streaming: true,
            },
            'message append: upstream anthropic error (stream)',
          )
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`,
          )
          reply.raw.end()
          return reply
        }
        clearTimeout(timeoutHandle)

        // Empty-tokens edge case (refusal, model glitch): still persist an
        // empty assistant message and emit `event: done`. Parity with
        // blocking-path behavior where messages.create returning empty text
        // would produce an empty assistant row.
        const replyText = assembledText.trim()
        const persisted = await persistMessagePair({
          db,
          session,
          userId: user.sub,
          content,
          replyText,
          clientLamport,
          incomingLamport,
          historyLength: historyRows.length,
        }).catch((err) => {
          req.log.error(
            { err, sessionId: id, userId: user.sub },
            'message append: persist failed (stream)',
          )
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Failed to persist messages' })}\n\n`,
          )
          reply.raw.end()
          return null
        })
        if (!persisted) return reply

        req.log.info(
          {
            metric: 'chat.sessions.append.complete',
            sessionId: id,
            userId: user.sub,
            contextKind: session.contextKind,
            duration_ms: Date.now() - startedAtMs,
            replyLength: replyText.length,
            streaming: true,
            truncatedTurns,
          },
          'message append: complete (stream)',
        )

        reply.raw.write(`event: done\ndata: ${JSON.stringify(persisted)}\n\n`)
        reply.raw.end()
        return reply
      }

      // ─── BLOCKING PATH — unchanged contract for non-streaming callers ──
      let result: Anthropic.Message
      try {
        result = await client.messages.create(
          {
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 2048,
            system: systemPrompt,
            messages: claudeMessages,
          },
          { signal: abortController.signal },
        )
      } catch (err) {
        clearTimeout(timeoutHandle)
        const gw = toGatewayErrorIfAnthropic(err)
        if (gw) {
          req.log.warn(
            {
              metric: 'chat.sessions.append.error',
              sessionId: id,
              userId: user.sub,
              duration_ms: Date.now() - startedAtMs,
              errCode: gw.code,
            },
            'message append: upstream anthropic error',
          )
          throw gw
        }
        req.log.error({ err, sessionId: id, userId: user.sub }, 'message append: unhandled error')
        throw err
      }
      clearTimeout(timeoutHandle)

      const replyText = result.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      if (!replyText) {
        throw new GatewayError({
          statusCode: 502,
          code: 'CHAT_EMPTY',
          message: 'Claude returned no text content.',
        })
      }

      const persisted = await persistMessagePair({
        db,
        session,
        userId: user.sub,
        content,
        replyText,
        clientLamport,
        incomingLamport,
        historyLength: historyRows.length,
      })

      req.log.info(
        {
          metric: 'chat.sessions.append.complete',
          sessionId: id,
          userId: user.sub,
          contextKind: session.contextKind,
          duration_ms: Date.now() - startedAtMs,
          inputTokens: result.usage?.input_tokens ?? null,
          outputTokens: result.usage?.output_tokens ?? null,
          model: result.model,
          replyLength: replyText.length,
          truncatedTurns,
        },
        'message append: complete',
      )

      return persisted
    },
  })
}

// Shared persist helper used by both the blocking and streaming branches
// of POST /chat/sessions/:id/messages. Performs the lamport mint, the
// 2-message INSERT + session UPDATE + re-fetch, and assembles the
// response payload in the canonical shape both clients expect.
//
// On INSERT/UPDATE failure: throws GatewayError 500. Streaming caller
// catches that, emits `event: error`, and ends the response; blocking
// caller lets it propagate as a normal 500.
async function persistMessagePair(args: {
  db: ReturnType<typeof getDb>
  session: SessionRow
  userId: string
  content: string
  replyText: string
  clientLamport: string
  incomingLamport: bigint
  historyLength: number
}): Promise<{
  session: z.infer<typeof ChatSessionListItemSchema>
  userMessage: z.infer<typeof ChatMessageSchema>
  assistantMessage: z.infer<typeof ChatMessageSchema>
}> {
  const { db, session, userId, content, replyText, clientLamport, incomingLamport, historyLength } = args

  // Server-mint lamport for assistant message + session bump.
  const wallLamport = BigInt(Date.now())
  const assistantLamport = (
    (incomingLamport > wallLamport ? incomingLamport : wallLamport) + 1n
  ).toString()

  const userMessageId = createId()
  const assistantMessageId = createId()
  const nowDate = new Date()

  try {
    await db.insert(schema.chatSessionMessages).values([
      {
        id: userMessageId,
        sessionId: session.id,
        role: 'user',
        content,
        lamport: clientLamport,
      },
      {
        id: assistantMessageId,
        sessionId: session.id,
        role: 'assistant',
        content: replyText,
        lamport: assistantLamport,
      },
    ])

    // Auto-title on first exchange: when title is null and we just added
    // the first user+assistant pair, take the first ~60 chars of the
    // user message as the title. Heuristic; LLM-generated title later.
    const isFirstExchange = historyLength === 0
    const previewText = replyText.slice(0, 200)
    const autoTitle =
      isFirstExchange && !session.title ? content.slice(0, 60).trim() : session.title

    await db
      .update(schema.chatSessions)
      .set({
        title: autoTitle,
        previewText,
        messageCount: session.messageCount + 2,
        lastMessageAt: nowDate,
        lamport: assistantLamport,
        updatedAt: nowDate,
        updatedByUserId: userId,
      })
      .where(eq(schema.chatSessions.id, session.id))
  } catch (err) {
    throw new GatewayError({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Failed to persist messages',
      details: { err: String(err) },
    })
  }

  const [updatedSession] = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, session.id))

  return {
    session: serializeSession(updatedSession!),
    userMessage: {
      id: userMessageId,
      sessionId: session.id,
      role: 'user' as const,
      content,
      citations: null,
      attachmentsJson: null,
      createdAt: nowDate.toISOString(),
      lamport: clientLamport,
    },
    assistantMessage: {
      id: assistantMessageId,
      sessionId: session.id,
      role: 'assistant' as const,
      content: replyText,
      citations: null,
      attachmentsJson: null,
      createdAt: nowDate.toISOString(),
      lamport: assistantLamport,
    },
  }
}

// Stable base system prompt — identical across every send, so Anthropic's
// prompt cache hits free after the first request per cache window.
const BASE_CHAT_SYSTEM_PROMPT =
  'You are Cyggie, a helpful AI assistant for venture investors. ' +
  'You are inside an ongoing chat conversation; reference prior turns naturally. ' +
  'Be concise, direct, and concrete. Avoid hedging. ' +
  'If you do not know something, say so plainly.'

// Phase 2.5 — segmented system prompt with cache_control on the context
// segment. Anthropic's prompt-caching layer hashes prefix segments;
// marking the last segment with `cache_control: ephemeral` caches up
// to and including that segment (5-min TTL). Within a session where
// the user keeps the same company selection, the entire system prompt
// is cached after the first send → input cost ≈ 10% of base.
//
// Cache invalidates when the context block bytes change (e.g. user
// adds/removes a company, or the underlying meeting summary updates).
// One fresh send rebuilds the cache; subsequent sends hit again.
//
// Returned array shape matches Anthropic's Message API:
//   - 1 segment when contextBlock is null (base prompt only)
//   - 2 segments when contextBlock is non-null (base + cached context)
export function buildChatSessionSystemSegments(
  contextBlock: string | null,
): Anthropic.MessageCreateParams['system'] {
  if (!contextBlock) {
    return [{ type: 'text', text: BASE_CHAT_SYSTEM_PROMPT }]
  }
  return [
    { type: 'text', text: BASE_CHAT_SYSTEM_PROMPT },
    {
      type: 'text',
      text: `\n\nGround your answers in the following context when relevant.\n\n${contextBlock}`,
      cache_control: { type: 'ephemeral' },
    },
  ]
}

// T17a A3 — contextKind-aware context builder. Returns a markdown-ish
// block to inject into the system prompt, or null when the session's
// contextKind has no specialized builder (crm/search-results — for
// those the conversation itself + session.contextLabel are sufficient).
async function buildContextForSession(
  db: ReturnType<typeof getDb>,
  session: typeof schema.chatSessions.$inferSelect,
): Promise<string | null> {
  switch (session.contextKind) {
    case 'meeting':
      return buildMeetingContextForChat(db, session.contextId, session.userId)
    case 'company':
      return buildCompanyContextForChat(db, session.contextId, session.userId)
    case 'contact':
      return buildContactContextForChat(db, session.contextId, session.userId)
    case 'search-results':
      // contextLabel holds the search query; surface it as a brief framing
      // line so Claude knows the conversation started from a search.
      return session.contextLabel
        ? `The user is chatting in the context of a search for: "${session.contextLabel}"`
        : null
    case 'crm':
    default:
      // Phase 2 (Mobile Chat): if the user has picked companies via the
      // pill row, inject each one's context (name + industry + stage +
      // description + recent meetings) — same shape buildCompanyContextForChat
      // produces for the company-detail chat surface. Empty → null
      // (status quo); 1+ selected → aggregated context block.
      if (session.selectedCompanyIds && session.selectedCompanyIds.length > 0) {
        return buildSelectedCompaniesContext(
          db,
          session.selectedCompanyIds,
          session.userId,
        )
      }
      return null
  }
}

// Phase 2.5: defensive cap on aggregated company-context size. Raised
// 100K → 300K to accommodate per-meeting summary + transcript content
// (notes/summary/transcript per recent meeting × 5 meetings × ~5
// companies fits in ~300K). Still well under Claude's 200K-token
// (~800K-char) input window. Per the no-cap UX decision: silently
// drops trailing companies that push past this.
const SELECTED_COMPANIES_MAX_CHARS = 300_000

// Phase 2.5: per-meeting truncation caps for the new
// composeMeetingContextBlock helper. The transcript cap is independent
// of the summary cap so one can't crowd out the other when both are
// present.
const SUMMARY_PER_MEETING_CAP = 6_000
const TRANSCRIPT_PER_MEETING_CAP = 6_000
const NOTES_PER_MEETING_CAP = 2_000

// =============================================================================
// composeMeetingContextBlock — formats one meeting for the LLM system prompt.
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ Meeting: <title> — <date>                                  │  always
//   │                                                            │
//   │ Notes:                                                     │  if notes
//   │ <truncated user-written notes>                             │
//   │                                                            │
//   │ Summary:                                                   │  if summary
//   │ <truncated AI-generated summary>                           │
//   │                                                            │
//   │ Transcript:                                                │  if transcript
//   │ <flattened + truncated transcript>                         │
//   └────────────────────────────────────────────────────────────┘
//
// Summary and transcript are BOTH included when present (no either/or
// branching): the bug fixed in Phase 2.5 was the summary missing a
// specific the user wanted to ask about — raw transcript carries those
// details. Each section has its own truncation cap.
// =============================================================================
export function composeMeetingContextBlock(args: {
  title: string | null
  date: Date
  notes: string | null
  summary: string | null
  transcriptSegmentsRaw: unknown
}): string {
  const parts: string[] = [
    `Meeting: ${args.title ?? '(untitled)'} — ${args.date.toLocaleDateString()}`,
  ]

  if (args.notes && args.notes.trim()) {
    parts.push(`Notes:\n${truncateString(args.notes, NOTES_PER_MEETING_CAP)}`)
  }
  if (args.summary && args.summary.trim()) {
    parts.push(`Summary:\n${truncateString(args.summary, SUMMARY_PER_MEETING_CAP)}`)
  }
  const transcript = flattenSegments(args.transcriptSegmentsRaw)
  if (transcript.length > 0) {
    parts.push(`Transcript:\n${truncateString(transcript, TRANSCRIPT_PER_MEETING_CAP)}`)
  }

  return parts.join('\n\n')
}

// Plain truncation helper with a visible marker — mirrors the pattern
// of truncateTranscript in transcript-flatten.ts but with a generic
// marker. Local to chat.ts to avoid premature extraction.
function truncateString(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n[...truncated...]`
}

// Hydrates a list of selected_company_ids into chip-shaped DTOs by joining
// org_companies. Stale IDs (company deleted between selection + fetch)
// don't appear in the result — they're silently filtered. Order is
// stable wrt the input order so the mobile pill row is deterministic.
async function hydrateSelectedCompanies(
  db: ReturnType<typeof getDb>,
  companyIds: string[],
  userId: string,
): Promise<Array<z.infer<typeof CompanyChipSchema>>> {
  if (companyIds.length === 0) return []
  const rows = await db
    .select({
      id: schema.orgCompanies.id,
      name: schema.orgCompanies.canonicalName,
      industry: schema.orgCompanies.industry,
      stage: schema.orgCompanies.stage,
    })
    .from(schema.orgCompanies)
    .where(
      and(
        inArray(schema.orgCompanies.id, companyIds),
        eq(schema.orgCompanies.userId, userId),
      ),
    )
  // Preserve input ordering — gives the pill row deterministic layout
  // matching the order companies were added.
  const byId = new Map(rows.map((r) => [r.id, r]))
  return companyIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
}

// Phase 2: batched-query context builder for the global Ask Cyggie chat's
// selected companies. Replaces an N+1 Promise.all of
// buildCompanyContextForChat with exactly 2 SQL round-trips regardless
// of how many companies are selected:
//   Query 1: every selected company in one IN-list lookup.
//   Query 2: meetings for every selected company in one IN-list JOIN.
// Meetings are grouped client-side and trimmed to top-5-per-company.
//
// Per-company output is byte-identical to buildCompanyContextForChat
// so the LLM sees the same shape whether the user came from a company
// detail chat OR picked the company in the global chat.
//
// Combined output is truncated at SELECTED_COMPANIES_MAX_CHARS — trailing
// companies past the cap are silently dropped (no-cap UX decision).
export async function buildSelectedCompaniesContext(
  db: ReturnType<typeof getDb>,
  companyIds: string[],
  userId: string,
): Promise<string | null> {
  if (companyIds.length === 0) return null

  // Query 1: companies — same column set as buildCompanyContextForChat.
  const companies = await db
    .select({
      id: schema.orgCompanies.id,
      name: schema.orgCompanies.canonicalName,
      description: schema.orgCompanies.description,
      industry: schema.orgCompanies.industry,
      stage: schema.orgCompanies.stage,
    })
    .from(schema.orgCompanies)
    .where(
      and(
        inArray(schema.orgCompanies.id, companyIds),
        eq(schema.orgCompanies.userId, userId),
      ),
    )
  if (companies.length === 0) return null

  // Query 2: meetings for all of them in one go. We deliberately do NOT
  // use a per-company LIMIT 5 (would need a window function); fetch
  // ordered-by-date-desc and trim per company in JS.
  //
  // Phase 2.5: SELECT extended with notes/summary/transcriptSegments so
  // composeMeetingContextBlock can render the full per-meeting context
  // (was title+date only). Always-include-both decision means we always
  // need transcriptSegments — no two-pass optimization.
  const validIds = companies.map((c) => c.id)
  const allMeetings = await db
    .select({
      companyId: schema.meetingCompanyLinks.companyId,
      title: schema.meetings.title,
      date: schema.meetings.date,
      notes: schema.meetings.notes,
      summary: schema.meetings.summary,
      transcriptSegments: schema.meetings.transcriptSegments,
    })
    .from(schema.meetingCompanyLinks)
    .innerJoin(
      schema.meetings,
      eq(schema.meetingCompanyLinks.meetingId, schema.meetings.id),
    )
    .where(
      and(
        inArray(schema.meetingCompanyLinks.companyId, validIds),
        eq(schema.meetings.userId, userId),
      ),
    )
    .orderBy(desc(schema.meetings.date))

  // Bucket meetings by companyId, top-5 per (preserves desc-date order
  // since the SQL was already ORDER BY date DESC).
  const meetingsByCompany = new Map<string, typeof allMeetings>()
  for (const m of allMeetings) {
    const bucket = meetingsByCompany.get(m.companyId) ?? []
    if (bucket.length < 5) {
      bucket.push(m)
      meetingsByCompany.set(m.companyId, bucket)
    }
  }

  // Compose per-company blocks in input order (matches selection order).
  const byId = new Map(companies.map((c) => [c.id, c]))
  const blocks: string[] = []
  let runningSize = 0
  for (const id of companyIds) {
    const c = byId.get(id)
    if (!c) continue // stale ID, silently skip
    const parts: string[] = [`COMPANY: ${c.name}`]
    if (c.industry) parts.push(`Industry: ${c.industry}`)
    if (c.stage) parts.push(`Stage: ${c.stage}`)
    if (c.description) parts.push(`Description: ${c.description}`)
    const meetingRows = meetingsByCompany.get(c.id) ?? []
    if (meetingRows.length > 0) {
      // Phase 2.5: each meeting now renders as a full block with
      // notes/summary/transcript (whichever are present), not just
      // a title+date line.
      const meetingBlocks = meetingRows.map((m) =>
        composeMeetingContextBlock({
          title: m.title,
          date: m.date,
          notes: m.notes,
          summary: m.summary,
          transcriptSegmentsRaw: m.transcriptSegments,
        }),
      )
      parts.push(`Recent meetings:\n\n${meetingBlocks.join('\n\n')}`)
    }
    const block = parts.join('\n')
    // Defensive total-size cap: drop trailing blocks rather than letting
    // the system prompt grow unbounded. Includes the "\n\n---\n\n"
    // separator (8 chars) in the per-block accounting.
    const blockSize = block.length + (blocks.length === 0 ? 0 : 8)
    if (runningSize + blockSize > SELECTED_COMPANIES_MAX_CHARS) break
    runningSize += blockSize
    blocks.push(block)
  }

  return blocks.length === 0 ? null : blocks.join('\n\n---\n\n')
}

async function buildMeetingContextForChat(
  db: ReturnType<typeof getDb>,
  meetingId: string,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      title: schema.meetings.title,
      notes: schema.meetings.notes,
      transcriptSegments: schema.meetings.transcriptSegments,
    })
    .from(schema.meetings)
    .where(and(eq(schema.meetings.id, meetingId), eq(schema.meetings.userId, userId)))
    .limit(1)
  const m = rows[0]
  if (!m) return null
  return buildMeetingContext(m.title, m.notes, m.transcriptSegments as unknown)
}

// Phase 2.5: per-entity company chat delegates to the multi-company
// helper. Single-company case is just the multi-company case with one
// ID — same SELECT, same composition, same defensive cap, zero
// duplication. Side effect: the per-entity surface now inherits the
// 300K defensive cap (was unbounded). With one company × 5 meetings,
// nowhere near the cap. Mental model: "company chat = global chat
// with that company selected" is now literally true.
export async function buildCompanyContextForChat(
  db: ReturnType<typeof getDb>,
  companyId: string,
  userId: string,
): Promise<string | null> {
  return buildSelectedCompaniesContext(db, [companyId], userId)
}

export async function buildContactContextForChat(
  db: ReturnType<typeof getDb>,
  contactId: string,
  userId: string,
): Promise<string | null> {
  const contactRows = await db
    .select({
      fullName: schema.contacts.fullName,
      title: schema.contacts.title,
      email: schema.contacts.email,
      primaryCompanyId: schema.contacts.primaryCompanyId,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, contactId),
        eq(schema.contacts.userId, userId),
      ),
    )
    .limit(1)
  const c = contactRows[0]
  if (!c) return null

  // Primary company name (separate lookup; could be null).
  let companyName: string | null = null
  if (c.primaryCompanyId) {
    const compRows = await db
      .select({ name: schema.orgCompanies.canonicalName })
      .from(schema.orgCompanies)
      .where(eq(schema.orgCompanies.id, c.primaryCompanyId))
      .limit(1)
    companyName = compRows[0]?.name ?? null
  }

  // Recent meetings the contact participated in (last 5, via
  // meeting_speaker_contact_links).
  //
  // Phase 2.5: SELECT extended with notes/summary/transcriptSegments so
  // the per-meeting render below can use composeMeetingContextBlock
  // (same shape as the company surfaces).
  const meetingRows = await db
    .select({
      title: schema.meetings.title,
      date: schema.meetings.date,
      notes: schema.meetings.notes,
      summary: schema.meetings.summary,
      transcriptSegments: schema.meetings.transcriptSegments,
    })
    .from(schema.meetingSpeakerContactLinks)
    .innerJoin(
      schema.meetings,
      eq(schema.meetingSpeakerContactLinks.meetingId, schema.meetings.id),
    )
    .where(
      and(
        eq(schema.meetingSpeakerContactLinks.contactId, contactId),
        eq(schema.meetings.userId, userId),
      ),
    )
    .orderBy(desc(schema.meetings.date))
    .limit(5)

  const parts: string[] = [`CONTACT: ${c.fullName}`]
  if (c.title) parts.push(`Title: ${c.title}`)
  if (companyName) parts.push(`Company: ${companyName}`)
  if (c.email) parts.push(`Email: ${c.email}`)
  if (meetingRows.length > 0) {
    // Phase 2.5: full per-meeting blocks via the shared helper (was
    // title+date-only line). Single contact, no aggregation cap needed;
    // per-meeting caps inside composeMeetingContextBlock keep output
    // bounded (5 × ~10K = ~50K worst case).
    const meetingBlocks = meetingRows.map((m) =>
      composeMeetingContextBlock({
        title: m.title,
        date: m.date,
        notes: m.notes,
        summary: m.summary,
        transcriptSegmentsRaw: m.transcriptSegments,
      }),
    )
    parts.push(`Recent meetings:\n\n${meetingBlocks.join('\n\n')}`)
  }
  return parts.join('\n')
}

function buildMeetingContext(
  title: string | null,
  notes: string | null,
  transcriptSegmentsRaw: unknown,
): string {
  const parts: string[] = []
  parts.push(`MEETING TITLE: ${title ?? '(untitled)'}`)
  if (notes && notes.trim().length > 0) {
    parts.push(`USER NOTES:\n${notes}`)
  }
  const transcript = flattenSegments(transcriptSegmentsRaw)
  if (transcript.length > 0) {
    parts.push(`TRANSCRIPT:\n${truncateTranscript(transcript)}`)
  }
  return parts.join('\n\n')
}

// Re-export so callers don't need to import from the helper directly when
// they just want the budget constant for tests / comments.
export { TRANSCRIPT_CONTEXT_BUDGET }
