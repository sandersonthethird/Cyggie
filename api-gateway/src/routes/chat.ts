import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { resolveAnthropicKey, toGatewayErrorIfAnthropic } from '../llm/resolve-key'
import {
  TRANSCRIPT_CONTEXT_BUDGET,
  flattenSegments,
  truncateTranscript,
} from '../llm/transcript-flatten'

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
