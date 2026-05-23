import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
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
// /chat — M5-thin: stateless one-shot Q&A against Claude.
//
// Body:
//   { message: string, meetingId?: string }
//
// Behavior:
//   • If meetingId provided, fetch the meeting (title + summary + first
//     50KB of transcript) and inject as system context.
//   • Otherwise, generic chat (model answers with no Cyggie context).
//   • Returns the full reply as a single string (no streaming).
//
// Follow-ups in TODOS as: chat_session persistence + sync, SSE streaming,
// multi-turn history, citations into transcript ranges.
//
// The orphan POST /chat/enhance-notes that rewrote typed notes has been
// removed — desktop-parity Enhance now lives at POST /meetings/:id/enhance
// and operates on the transcript with a template (see routes/meetings.ts).
// =============================================================================

export async function registerChatRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'POST',
    url: '/chat/messages',
    schema: {
      body: z.object({
        message: z.string().min(1).max(8000),
        meetingId: z.string().max(64).optional(),
      }),
      response: {
        200: z.object({
          reply: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const { message, meetingId } = req.body

      const apiKey = await resolveAnthropicKey(env, user.sub)
      if (!apiKey) {
        throw new GatewayError({
          statusCode: 503,
          code: 'CHAT_UNAVAILABLE',
          message:
            'No Anthropic API key configured. Set one in desktop Settings → AI & Transcription.',
        })
      }

      let meetingContext: string | null = null
      if (meetingId) {
        const db = getDb(env.GATEWAY_DATABASE_URL)
        const rows = await db
          .select({
            title: schema.meetings.title,
            notes: schema.meetings.notes,
            transcriptSegments: schema.meetings.transcriptSegments,
          })
          .from(schema.meetings)
          .where(
            and(eq(schema.meetings.id, meetingId), eq(schema.meetings.userId, user.sub)),
          )
          .limit(1)
        const m = rows[0]
        if (!m) {
          throw new GatewayError({
            statusCode: 404,
            code: 'MEETING_NOT_FOUND',
            message: 'Meeting not found.',
          })
        }
        meetingContext = buildMeetingContext(
          m.title,
          m.notes,
          m.transcriptSegments as unknown,
        )
      }

      const systemPrompt = buildSystemPrompt(meetingContext)
      const client = new Anthropic({ apiKey })

      // Issue 8A telemetry — record start so we can compute duration even
      // when the call errors out partway through.
      const startedAtMs = Date.now()
      req.log.info(
        { metric: 'chat.messages.start', userId: user.sub, meetingId: meetingId ?? null },
        'chat start',
      )

      let result
      try {
        result = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: message }],
        })
      } catch (err) {
        const gw = toGatewayErrorIfAnthropic(err)
        if (gw) throw gw
        throw err
      }

      // The SDK returns a content array — we asked for a single text reply,
      // so any text blocks concatenated is the answer.
      const reply = result.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      if (!reply) {
        throw new GatewayError({
          statusCode: 502,
          code: 'CHAT_EMPTY',
          message: 'Claude returned no text content.',
        })
      }

      req.log.info(
        {
          metric: 'chat.messages.complete',
          userId: user.sub,
          meetingId: meetingId ?? null,
          duration_ms: Date.now() - startedAtMs,
          inputTokens: result.usage?.input_tokens ?? null,
          outputTokens: result.usage?.output_tokens ?? null,
          model: result.model,
          replyLength: reply.length,
        },
        'chat complete',
      )

      return { reply }
    },
  })

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
}

function buildSystemPrompt(meetingContext: string | null): string {
  const base =
    'You are Cyggie, a helpful AI assistant for venture investors. ' +
    'Be concise, direct, and concrete. Avoid hedging. ' +
    'If you do not know something, say so plainly.'
  if (!meetingContext) return base
  return `${base}\n\nThe user is asking in the context of the following meeting. Ground your answer in this context when relevant.\n\n${meetingContext}`
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
