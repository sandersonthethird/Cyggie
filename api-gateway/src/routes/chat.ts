import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
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

const ChatSessionDetailSchema = z.object({
  session: ChatSessionListItemSchema,
  messages: z.array(ChatMessageSchema),
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

      return {
        session: serializeSession(session),
        messages: messages.map(serializeMessage),
      }
    },
  })

  // PATCH /chat/sessions/:id — partial update (title / isPinned / isArchived).
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
      if (!hasField) {
        throw new GatewayError({
          statusCode: 400,
          code: 'CHAT_SESSION_PATCH_EMPTY',
          message: 'PATCH must include at least one of: title, isPinned, isArchived.',
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
        content: z.string().min(1).max(8000),
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
      const systemPrompt = buildChatSessionSystemPrompt(contextBlock)

      // Compose Claude messages: history + new user message.
      const claudeMessages: Anthropic.MessageParam[] = historyRows
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      claudeMessages.push({ role: 'user', content })

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
        },
        'message append: start',
      )

      const client = new Anthropic({ apiKey })
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

      // Server-mint lamport for assistant message + session bump.
      const wallLamport = BigInt(Date.now())
      const assistantLamport = (
        (incomingLamport > wallLamport ? incomingLamport : wallLamport) + 1n
      ).toString()

      const userMessageId = createId()
      const assistantMessageId = createId()
      const nowDate = new Date()

      // Persist both messages + bump session metadata. Three writes; on
      // any failure throw 500 and the client retries (idempotent by id).
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

        // Auto-title on first exchange: when title is null and we just
        // added the first user+assistant pair, take the first ~60 chars
        // of the user message as the title. Heuristic; T-something tracks
        // an LLM-generated title later.
        const isFirstExchange = historyRows.length === 0
        const previewText = replyText.slice(0, 200)
        const autoTitle =
          isFirstExchange && !session.title
            ? content.slice(0, 60).trim()
            : session.title

        await db
          .update(schema.chatSessions)
          .set({
            title: autoTitle,
            previewText,
            messageCount: session.messageCount + 2,
            lastMessageAt: nowDate,
            lamport: assistantLamport,
            updatedAt: nowDate,
            updatedByUserId: user.sub,
          })
          .where(eq(schema.chatSessions.id, session.id))
      } catch (err) {
        req.log.error(
          { err, sessionId: id, userId: user.sub },
          'message append: persist failed',
        )
        throw new GatewayError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Failed to persist messages',
        })
      }

      // Re-fetch the updated session for the response. Cheap; one row.
      const [updatedSession] = await db
        .select()
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.id, session.id))

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
        },
        'message append: complete',
      )

      // Build the response. We re-fetch messages so the client gets the
      // canonical createdAt timestamps.
      const userMessage = {
        id: userMessageId,
        sessionId: session.id,
        role: 'user' as const,
        content,
        citations: null,
        attachmentsJson: null,
        createdAt: nowDate.toISOString(),
        lamport: clientLamport,
      }
      const assistantMessage = {
        id: assistantMessageId,
        sessionId: session.id,
        role: 'assistant' as const,
        content: replyText,
        citations: null,
        attachmentsJson: null,
        createdAt: nowDate.toISOString(),
        lamport: assistantLamport,
      }

      return {
        session: serializeSession(updatedSession!),
        userMessage,
        assistantMessage,
      }
    },
  })
}

// T17a A3 — system prompt for chat-session messages. Tells the model
// it is mid-conversation, plus an optional context block drawn from
// the session's contextKind+contextId.
function buildChatSessionSystemPrompt(contextBlock: string | null): string {
  const base =
    'You are Cyggie, a helpful AI assistant for venture investors. ' +
    'You are inside an ongoing chat conversation; reference prior turns naturally. ' +
    'Be concise, direct, and concrete. Avoid hedging. ' +
    'If you do not know something, say so plainly.'
  if (!contextBlock) return base
  return `${base}\n\nGround your answers in the following context when relevant.\n\n${contextBlock}`
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
      return null
  }
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

async function buildCompanyContextForChat(
  db: ReturnType<typeof getDb>,
  companyId: string,
  userId: string,
): Promise<string | null> {
  const companyRows = await db
    .select({
      name: schema.orgCompanies.canonicalName,
      description: schema.orgCompanies.description,
      industry: schema.orgCompanies.industry,
      stage: schema.orgCompanies.stage,
    })
    .from(schema.orgCompanies)
    .where(
      and(
        eq(schema.orgCompanies.id, companyId),
        eq(schema.orgCompanies.userId, userId),
      ),
    )
    .limit(1)
  const c = companyRows[0]
  if (!c) return null

  // Recent meetings linked to this company (last 5, title + date).
  const meetingRows = await db
    .select({
      title: schema.meetings.title,
      date: schema.meetings.date,
    })
    .from(schema.meetingCompanyLinks)
    .innerJoin(
      schema.meetings,
      eq(schema.meetingCompanyLinks.meetingId, schema.meetings.id),
    )
    .where(
      and(
        eq(schema.meetingCompanyLinks.companyId, companyId),
        eq(schema.meetings.userId, userId),
      ),
    )
    .orderBy(desc(schema.meetings.date))
    .limit(5)

  const parts: string[] = [`COMPANY: ${c.name}`]
  if (c.industry) parts.push(`Industry: ${c.industry}`)
  if (c.stage) parts.push(`Stage: ${c.stage}`)
  if (c.description) parts.push(`Description: ${c.description}`)
  if (meetingRows.length > 0) {
    const meetingLines = meetingRows
      .map((m) => `  - ${m.title} (${new Date(m.date).toLocaleDateString()})`)
      .join('\n')
    parts.push(`Recent meetings:\n${meetingLines}`)
  }
  return parts.join('\n')
}

async function buildContactContextForChat(
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
  const meetingRows = await db
    .select({
      title: schema.meetings.title,
      date: schema.meetings.date,
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
    const meetingLines = meetingRows
      .map((m) => `  - ${m.title} (${new Date(m.date).toLocaleDateString()})`)
      .join('\n')
    parts.push(`Recent meetings:\n${meetingLines}`)
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
