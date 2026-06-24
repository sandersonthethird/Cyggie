import type { FastifyInstance, FastifyBaseLogger } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import { createId } from '@paralleldrive/cuid2'
import { schema, extractCitations, type Citation } from '@cyggie/db'
import { stripContextIdPrefix } from '@cyggie/shared'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { resolveAnthropicKey, toGatewayErrorIfAnthropic } from '../llm/resolve-key'
import { resolveUserModel } from '../llm/resolve-user-model'
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
import {
  CHAT_MODEL,
  runAgentTurn,
  createAgentStream,
  buildContextForSession,
  collectContextEntities,
  buildChatSessionSystemSegments,
  // Re-exported below for backwards compatibility with existing test
  // imports (api-gateway/test/chat-selected-companies.test.ts).
  buildCompanyContextForChat,
  buildContactContextForChat,
  buildSelectedCompaniesContext,
  composeMeetingContextBlock,
} from '../services/chat-agent'

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
  // Per-chat Anthropic prompt-caching toggle (migration 0020 / SQLite 103).
  // True = context block is cached (5-min TTL ephemeral). False = no
  // cache_control, no cache write premium. Defaults true server-side.
  cacheEnabled: z.boolean().default(true),
})

// M5 citations — sources the assistant answer drew on (context-attributed).
const CitationSchema = z.object({
  type: z.enum(['meeting', 'company', 'contact', 'note']),
  id: z.string(),
  label: z.string(),
  timestamp: z.number().optional(),
})

const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  citations: z.array(CitationSchema).nullable(),
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
  primaryDomain: z.string().nullable(),
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
    // Default true: covers the brief migration window for rows created
    // before the cache_enabled column existed. Postgres column default
    // is true, so this fallback should never actually fire.
    cacheEnabled: row.cacheEnabled ?? true,
  }
}

function serializeMessage(row: MessageRow): z.infer<typeof ChatMessageSchema> {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    citations: (row.citations as Citation[] | null) ?? null,
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
        // Optional exact-match filter on context_id (e.g. `company:<id>`).
        // Used by the per-entity "recent chats" surfaces to list every
        // session for a single entity (active + archived). Only narrows
        // within the caller's own rows — never broadens access.
        contextId: z.string().min(1).max(128).optional(),
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
      const { contextKind, contextId, includeArchived, limit, offset } = req.query

      const where = [
        eq(schema.chatSessions.userId, user.sub),
        // Defense-in-depth per External Agents V1 slice 6 acceptance
        // criterion: in-product chat list must never surface Slack-
        // originated sessions (origin='slack'). Without this filter,
        // a user whose id happens to equal CYGGIE_SLACK_DEFAULT_USER_ID
        // would see Slack threads mixed into their chat list with
        // contextIds shaped like `slack:<workspace>:<channel>:<thread>`.
        eq(schema.chatSessions.origin, 'app'),
      ]
      if (contextKind) {
        where.push(eq(schema.chatSessions.contextKind, contextKind))
      }
      if (contextId) {
        where.push(eq(schema.chatSessions.contextId, contextId))
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
        // Per-chat prompt-caching toggle (migration 0020 / SQLite 103).
        cacheEnabled: z.boolean().optional(),
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
      if (body.cacheEnabled !== undefined) {
        updates.cacheEnabled = body.cacheEnabled
        hasField = true
      }
      if (!hasField) {
        throw new GatewayError({
          statusCode: 400,
          code: 'CHAT_SESSION_PATCH_EMPTY',
          message: 'PATCH must include at least one of: title, isPinned, isArchived, selectedCompanyIds, cacheEnabled.',
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
      // origin='app' filter is defense-in-depth — the contextId format
      // ('slack:...' for Slack rows) already prevents collisions, but
      // explicit filtering keeps Slack sessions out of the route's
      // create-or-resume path even if a contextId format change ever
      // overlaps. Matches the slice 6 acceptance criterion.
      const existing = await db
        .select()
        .from(schema.chatSessions)
        .where(
          and(
            eq(schema.chatSessions.userId, user.sub),
            eq(schema.chatSessions.contextId, contextId),
            eq(schema.chatSessions.isActive, 1),
            eq(schema.chatSessions.origin, 'app'),
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
      // origin='app' filter mirrors the Step 1 query so both sides of the
      // race agree on which rows are eligible.
      const racedRows = await db
        .select()
        .from(schema.chatSessions)
        .where(
          and(
            eq(schema.chatSessions.userId, user.sub),
            eq(schema.chatSessions.contextId, contextId),
            eq(schema.chatSessions.isActive, 1),
            eq(schema.chatSessions.origin, 'app'),
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

      // Per-user chat model (desktop Settings → "Chat" dropdown, synced via
      // user_preferences). Falls back to CHAT_MODEL when unset.
      const chatModel = await resolveUserModel(env, user.sub, 'chatModel', CHAT_MODEL)

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
      const contextBlock = await buildContextForSession(db, session, req.log)
      // M5 citations — the candidate entities injected into context. Cited
      // post-hoc by extractCitations (the answer must NAME them). Collected
      // best-effort: a failure here must never break the chat turn.
      let citationCandidates: Citation[] = []
      try {
        citationCandidates = await collectContextEntities(db, session)
      } catch (err) {
        req.log.warn(
          { err, sessionId: id, userId: user.sub, metric: 'chat.citations.collect_error' },
          'chat: collectContextEntities failed (non-fatal)',
        )
      }
      // Phase 2.5: segmented system prompt — base + (optional) context
      // segment. cache_control applied only when session.cacheEnabled.
      const systemPrompt = buildChatSessionSystemSegments(
        contextBlock,
        session.cacheEnabled,
      )

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
        let streamUsage: Anthropic.Messages.Usage | null = null
        try {
          const stream = createAgentStream({
            apiKey,
            model: chatModel,
            messages: claudeMessages,
            systemPrompt,
            signal: abortController.signal,
          })
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
          // Drain to capture finalMessage().usage for cache-hit telemetry.
          const finalMsg = await stream.finalMessage()
          streamUsage = finalMsg.usage
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
        let streamCitations: Citation[] = []
        try {
          streamCitations = extractCitations(replyText, citationCandidates)
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, metric: 'chat.citations.extract_error' },
            'chat: citation extract failed (stream, non-fatal)',
          )
        }
        const persisted = await persistMessagePair({
          db,
          session,
          userId: user.sub,
          content,
          replyText,
          citations: streamCitations,
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

        // Cache-hit telemetry. cache_creation > 0 on first cached turn;
        // cache_read > 0 on turn 2+ within the 5-min TTL. Use to validate
        // the per-chat cacheEnabled toggle is working as intended and to
        // detect silent invalidators (Date.now() in a prompt, etc.).
        if (streamUsage) {
          req.log.info(
            {
              metric: 'chat.sessions.usage',
              sessionId: id,
              userId: user.sub,
              cacheEnabled: session.cacheEnabled,
              inputTokens: streamUsage.input_tokens,
              outputTokens: streamUsage.output_tokens,
              cacheCreationInputTokens:
                streamUsage.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens:
                streamUsage.cache_read_input_tokens ?? 0,
              streaming: true,
            },
            'chat usage',
          )
        }

        reply.raw.write(`event: done\ndata: ${JSON.stringify(persisted)}\n\n`)
        reply.raw.end()
        return reply
      }

      // ─── BLOCKING PATH — unchanged contract for non-streaming callers ──
      let result: Anthropic.Message
      try {
        result = await runAgentTurn({
          apiKey,
          model: chatModel,
          messages: claudeMessages,
          systemPrompt,
          signal: abortController.signal,
        })
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

      let blockingCitations: Citation[] = []
      try {
        blockingCitations = extractCitations(replyText, citationCandidates)
      } catch (err) {
        req.log.warn(
          { err, sessionId: id, metric: 'chat.citations.extract_error' },
          'chat: citation extract failed (blocking, non-fatal)',
        )
      }
      const persisted = await persistMessagePair({
        db,
        session,
        userId: user.sub,
        content,
        replyText,
        citations: blockingCitations,
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

      // Cache-hit telemetry. See streaming-path equivalent above.
      req.log.info(
        {
          metric: 'chat.sessions.usage',
          sessionId: id,
          userId: user.sub,
          cacheEnabled: session.cacheEnabled,
          inputTokens: result.usage?.input_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? 0,
          cacheCreationInputTokens:
            result.usage?.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: result.usage?.cache_read_input_tokens ?? 0,
          streaming: false,
        },
        'chat usage',
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
  citations: Citation[]
  clientLamport: string
  incomingLamport: bigint
  historyLength: number
}): Promise<{
  session: z.infer<typeof ChatSessionListItemSchema>
  userMessage: z.infer<typeof ChatMessageSchema>
  assistantMessage: z.infer<typeof ChatMessageSchema>
}> {
  const { db, session, userId, content, replyText, citations, clientLamport, incomingLamport, historyLength } = args
  // Defensive cap — our own data, but never let a runaway candidate set bloat
  // the jsonb column or the wire payload.
  const safeCitations = citations.slice(0, 10)

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
        citations: safeCitations.length > 0 ? safeCitations : null,
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
      citations: safeCitations.length > 0 ? safeCitations : null,
      attachmentsJson: null,
      createdAt: nowDate.toISOString(),
      lamport: assistantLamport,
    },
  }
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
      primaryDomain: schema.orgCompanies.primaryDomain,
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

// ─── Re-exports for backwards compatibility ─────────────────────────────────
//
// Context builders + system-prompt helpers + agent-call functions moved to
// api-gateway/src/services/chat-agent/ in Slice 3 (External Agents V1).
// These re-exports preserve the previous import surface so existing tests
// (api-gateway/test/chat-selected-companies.test.ts) and any third-party
// consumers can keep importing from this module unchanged.
export {
  buildContextForSession,
  buildChatSessionSystemSegments,
  buildCompanyContextForChat,
  buildContactContextForChat,
  buildSelectedCompaniesContext,
  composeMeetingContextBlock,
} from '../services/chat-agent'

// Re-export so callers don't need to import from the helper directly when
// they just want the budget constant for tests / comments.
export { TRANSCRIPT_CONTEXT_BUDGET }

// ─── Removed inline definitions (now in services/chat-agent/) ───────────────
//
// The following functions and constants were inline here until Slice 3 of
// the External Agents V1 plan; see git log for the move:
//   - BASE_CHAT_SYSTEM_PROMPT             → services/chat-agent/system-prompts.ts
//   - buildChatSessionSystemSegments      → services/chat-agent/system-prompts.ts
//   - buildContextForSession              → services/chat-agent/context-builders.ts
//   - composeMeetingContextBlock          → services/chat-agent/context-builders.ts
//   - buildSelectedCompaniesContext       → services/chat-agent/context-builders.ts
//   - buildMeetingContextForChat          → services/chat-agent/context-builders.ts (internal)
//   - buildCompanyContextForChat          → services/chat-agent/context-builders.ts
//   - buildContactContextForChat          → services/chat-agent/context-builders.ts
//   - buildMeetingContext (legacy)        → services/chat-agent/context-builders.ts (internal)
//   - truncateString (helper)             → services/chat-agent/context-builders.ts (internal)
//   - SELECTED_COMPANIES_MAX_CHARS et al  → services/chat-agent/context-builders.ts (internal)
//
// The Anthropic call sites (client.messages.create / client.messages.stream)
// are now routed through runAgentTurn / createAgentStream from the same
// module so model + max_tokens + caching wiring live in one place.

