import { and, eq } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

// T24 key resolution. Lifted out of routes/chat.ts so meetings.ts (and any
// future LLM-consuming route) can share the same resolver without circular
// route imports.
//
// Order:
//   1. user_credentials row for (userId, 'anthropic') — set by desktop's
//      Settings UI via PUT /user-credentials/anthropic.
//   2. env.ANTHROPIC_API_KEY — single-firm beta fallback. Will be removed
//      when multi-tenant onboarding lands and the env key becomes a leak
//      vector for any user without their own row.
//   3. null → caller throws CHAT_UNAVAILABLE.
export async function resolveAnthropicKey(
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

// Surface upstream Anthropic errors as meaningful 4xx/5xx instead of the
// generic 500 INTERNAL_ERROR. The first time this caught a real failure
// it was a per-key spend limit — Anthropic's own message was clear and
// actionable ("You have reached your specified API usage limits…") but
// without this mapper the user saw "An unexpected error occurred".
//
// Status passthrough: most Anthropic errors are 4xx (user-facing key /
// quota issues). 5xx from Anthropic itself becomes 502 (bad gateway)
// since the gateway proxied to an upstream that failed.
export function toGatewayErrorIfAnthropic(err: unknown): GatewayError | null {
  if (!(err instanceof Anthropic.APIError)) return null
  // APIUserAbortError fires when our server-side AbortController timer
  // pulls the plug because Claude is taking too long. The default
  // message "Request was aborted." is technically correct but useless
  // to the end user — they don't know what aborted means. Surface it
  // as a 504 with an actionable string instead.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new GatewayError({
      statusCode: 504,
      code: 'CHAT_TIMEOUT',
      message:
        'Enhance is taking longer than the server timeout. Long transcripts can push past 60s — try again, or shorten the meeting on desktop first.',
      details: { upstreamStatus: 0 },
    })
  }
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
