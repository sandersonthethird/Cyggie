import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

// =============================================================================
// /chat — M5-thin: stateless one-shot Q&A against Claude.
//
// Why "thin": full M5 (chat_sessions persisted in Neon, sync to desktop,
// SSE streaming, multi-turn context, citations) is multi-week scope. This
// slice ships the smallest demo-able mobile AI feature so the first phone
// build has *something* on the Chat tab and we can validate the gateway
// → Claude → mobile round-trip end-to-end before investing in the rest.
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
// =============================================================================

const TRANSCRIPT_CONTEXT_BUDGET = 50_000

// Surface upstream Anthropic errors as meaningful 4xx/5xx instead of the
// generic 500 INTERNAL_ERROR. Caught the first time when a user hit a
// per-key spend limit and the gateway returned "An unexpected error
// occurred" — the actual message from Anthropic was clear and actionable
// ("You have reached your specified API usage limits. You will regain
// access on YYYY-MM-DD"). Forward it verbatim so the mobile UI shows
// the real cause.
//
// Status passthrough: most Anthropic errors are 4xx (user-facing key /
// quota issues). 5xx from Anthropic itself becomes 502 (bad gateway)
// since the gateway proxied to an upstream that failed.
function toGatewayErrorIfAnthropic(err: unknown): GatewayError | null {
  if (!(err instanceof Anthropic.APIError)) return null
  // Anthropic errors have .status (number, undefined for connection errors)
  // and a meaningful .message stripped of HTTP envelope noise.
  const status = typeof err.status === 'number' && err.status > 0 ? err.status : 502
  // Anthropic wraps the message as "STATUS {json}" in stringified form.
  // Pull the user-facing reason from .error.error.message if present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reason = (err as any).error?.error?.message ?? err.message
  return new GatewayError({
    statusCode: status >= 500 ? 502 : status,
    code: 'CHAT_PROVIDER_ERROR',
    message: typeof reason === 'string' ? reason : 'Upstream AI provider error',
    details: { upstreamStatus: status },
  })
}

// T24 key resolution. Order:
//   1. user_credentials row for (userId, 'anthropic') — set by desktop's
//      Settings UI via PUT /user-credentials/anthropic.
//   2. env.ANTHROPIC_API_KEY — single-firm beta fallback. Will be removed
//      when multi-tenant onboarding lands and the env key becomes a leak
//      vector for any user without their own row.
//   3. null → caller throws CHAT_UNAVAILABLE.
async function resolveAnthropicKey(
  env: GatewayEnv,
  userId: string,
): Promise<string | null> {
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const rows = await db
    .select({ value: schema.userCredentials.value })
    .from(schema.userCredentials)
    .where(
      and(
        eq(schema.userCredentials.userId, userId),
        eq(schema.userCredentials.provider, 'anthropic'),
      ),
    )
    .limit(1)
  if (rows[0]) return rows[0].value
  return env.ANTHROPIC_API_KEY ?? null
}

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

      return { reply }
    },
  })

  // ──────────────────────────────────────────────────────────────────────────
  // POST /chat/enhance-notes — AI-rewrite meeting notes.
  //
  // Takes the user's hand-typed meeting notes and returns a cleaned-up
  // version: fixes grammar, applies light structure (bullets where natural),
  // preserves all factual content. If meetingId is provided, the transcript
  // is fed as context so the model can disambiguate references in the notes.
  //
  // Returns the FULL rewritten note as a string. Client decides whether to
  // replace its editor buffer (we surface a diff modal in the mobile UI).
  // ──────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/chat/enhance-notes',
    schema: {
      body: z.object({
        content: z.string().min(1).max(20_000),
        meetingId: z.string().max(64).optional(),
      }),
      response: {
        200: z.object({
          enhanced: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const { content, meetingId } = req.body

      const apiKey = await resolveAnthropicKey(env, user.sub)
      if (!apiKey) {
        throw new GatewayError({
          statusCode: 503,
          code: 'CHAT_UNAVAILABLE',
          message:
            'No Anthropic API key configured. Set one in desktop Settings → AI & Transcription.',
        })
      }

      let transcriptCtx: string | null = null
      if (meetingId) {
        const db = getDb(env.GATEWAY_DATABASE_URL)
        const rows = await db
          .select({ transcriptSegments: schema.meetings.transcriptSegments })
          .from(schema.meetings)
          .where(
            and(eq(schema.meetings.id, meetingId), eq(schema.meetings.userId, user.sub)),
          )
          .limit(1)
        if (rows[0]) {
          const t = flattenSegments(rows[0].transcriptSegments as unknown)
          if (t.length > 0) {
            transcriptCtx =
              t.length > TRANSCRIPT_CONTEXT_BUDGET
                ? t.slice(0, TRANSCRIPT_CONTEXT_BUDGET) + '\n[...truncated...]'
                : t
          }
        }
      }

      const systemPrompt = buildEnhanceSystemPrompt(transcriptCtx)
      const client = new Anthropic({ apiKey })
      let result
      try {
        result = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: `ORIGINAL NOTES:\n${content}` }],
        })
      } catch (err) {
        const gw = toGatewayErrorIfAnthropic(err)
        if (gw) throw gw
        throw err
      }

      const enhanced = result.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      if (!enhanced) {
        throw new GatewayError({
          statusCode: 502,
          code: 'CHAT_EMPTY',
          message: 'Claude returned no text content.',
        })
      }

      return { enhanced }
    },
  })
}

function buildEnhanceSystemPrompt(transcriptCtx: string | null): string {
  const base =
    'You are an assistant that improves a venture investor\'s hand-typed meeting notes. ' +
    'RULES:\n' +
    '  1. Preserve every factual claim, number, name, and decision in the original.\n' +
    '  2. Fix grammar and spelling.\n' +
    '  3. Apply light structure: short bullets where the note is a list; ' +
    'paragraphs where it is prose. Do not invent headings unless original notes had them.\n' +
    '  4. Do NOT add new content, opinions, or speculation. Do not soften strong language.\n' +
    '  5. Output ONLY the rewritten notes. No preamble, no explanation.\n'
  if (!transcriptCtx) return base
  return `${base}\n\nThe meeting transcript is provided below for disambiguation only — do not copy from it, only use it to resolve unclear pronouns or shorthand in the user's notes.\n\nTRANSCRIPT:\n${transcriptCtx}`
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
    const truncated =
      transcript.length > TRANSCRIPT_CONTEXT_BUDGET
        ? transcript.slice(0, TRANSCRIPT_CONTEXT_BUDGET) + '\n[...transcript truncated...]'
        : transcript
    parts.push(`TRANSCRIPT:\n${truncated}`)
  }
  return parts.join('\n\n')
}

// transcript_segments is jsonb; the row shape is per the canonical
// TranscriptSegmentSchema in meetings.ts. We only need text + speakerLabel.
function flattenSegments(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  return raw
    .map((seg) => {
      if (typeof seg !== 'object' || seg === null) return ''
      const s = seg as { speakerLabel?: unknown; text?: unknown }
      const label =
        typeof s.speakerLabel === 'string' && s.speakerLabel.length > 0
          ? s.speakerLabel
          : 'Speaker'
      const text = typeof s.text === 'string' ? s.text : ''
      return `${label}: ${text}`
    })
    .filter((line) => line.length > 0)
    .join('\n')
}
