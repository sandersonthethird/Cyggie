import { and, eq } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import { Sentry } from '../sentry'
import { decryptToken, TokenCryptoError } from '../auth/token-crypto'
import type { GatewayEnv } from '../env'

// T24/T32 key resolution. Lifted out of routes/chat.ts so meetings.ts and
// recording/transcribe-job.ts (and any future provider-consuming code) can
// share the same resolver without circular route imports.
//
// Order:
//   1. user_credentials row for (userId, provider) — set by desktop's
//      Settings UI via PUT /user-credentials/:provider.
//   2. env.<PROVIDER>_API_KEY — single-firm beta fallback. Deleted per
//      provider as their multi-tenant gate ships (T24 retained Anthropic
//      fallback; T32 PR-B removes Deepgram fallback after verifying
//      Sandy's row exists in Neon).
//   3. null → caller throws a provider-specific 503.
//
// Slice A — the Anthropic env fallback is firm-gated so firm #2 can never bill
// Red Swan's shared key:
//
//   resolveAnthropicKey(env, userId, firmId)
//           │
//      user_credentials row for (userId,'anthropic')?
//           │
//      ┌────┴─────┐
//     yes         no
//      │           │
//    key      firmId === BETA_FIRM_ID ?
//                 ┌────┴────┐
//                yes        no
//                 │          │
//              env key      null ──▶ caller 503 (CHAT_UNAVAILABLE)
//
// (Slice C will wrap step 1 in decrypt; legacy plaintext tolerated transitionally.)

async function resolveProviderKeyFromDb(
  env: GatewayEnv,
  userId: string,
  provider: 'anthropic' | 'deepgram' | 'openai' | 'exa' | 'webshare',
): Promise<string | null> {
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const rows = await db
    .select({ value: schema.userCredentials.value })
    .from(schema.userCredentials)
    .where(
      and(
        eq(schema.userCredentials.userId, userId),
        eq(schema.userCredentials.provider, provider),
      ),
    )
    .limit(1)
  const stored = rows[0]?.value ?? null
  if (stored == null) return null
  return decryptStoredCredential(env, stored, provider, userId)
}

// Slice C — at-rest decryption with a transitional plaintext path.
//
//   stored value
//        │
//   CREDENTIAL_ENC_KEY set?
//        │
//   ┌────┴───────────┐
//  no                yes
//   │                 │
//  iv:tag:ct shaped?  decryptToken(value, CREDENTIAL_ENC_KEY)
//   ┌──┴──┐            ├─ ok ......................... → plaintext
//  yes    no           ├─ TokenCryptoError 'legacy' .. → value verbatim (RS plaintext)
//   │      │           └─ 'decrypt_failed'/'bad_key' . → Sentry + 503 (never upstream)
// 503    verbatim
// (misconfig:        (legacy plaintext, pre-encryption)
//  key removed
//  post-encrypt)
//
// The 'legacy' tolerance is transitional — removed once the re-encrypt script
// confirms zero plaintext rows (TODOS.md MF-2).
function decryptStoredCredential(
  env: GatewayEnv,
  stored: string,
  provider: string,
  userId: string,
): string {
  const looksEncrypted = stored.split(':').length === 3
  if (!env.CREDENTIAL_ENC_KEY) {
    // Pre-rollout: only legacy plaintext is expected. An encrypted-shaped value
    // with no key configured is a misconfiguration (key removed after encrypting)
    // — never hand ciphertext to a provider as if it were a key.
    if (looksEncrypted) throw credentialUnreadable(provider, userId, 'enc_key_missing')
    return stored
  }
  try {
    return decryptToken(stored, env.CREDENTIAL_ENC_KEY, 'CREDENTIAL_ENC_KEY')
  } catch (err) {
    if (err instanceof TokenCryptoError && err.kind === 'legacy') {
      return stored // Red Swan's pre-encryption plaintext (transitional, MF-2)
    }
    Sentry.captureException(err, {
      tags: { source: 'credential-decrypt', provider },
      extra: { userId },
    })
    throw credentialUnreadable(provider, userId, 'decrypt_failed')
  }
}

function credentialUnreadable(provider: string, userId: string, reason: string): GatewayError {
  return new GatewayError({
    statusCode: 503,
    code: 'CREDENTIAL_UNREADABLE',
    message:
      'A stored API key could not be decrypted. Re-enter it in desktop Settings → AI & Transcription.',
    details: { provider, userId, reason },
  })
}

export async function resolveAnthropicKey(
  env: GatewayEnv,
  userId: string,
  firmId: string | null,
): Promise<string | null> {
  const fromDb = await resolveProviderKeyFromDb(env, userId, 'anthropic')
  if (fromDb) return fromDb
  // Firm-gated env fallback: only the beta firm (Red Swan) may use the shared
  // ANTHROPIC_API_KEY. Any other firm — or an unset BETA_FIRM_ID — gets null so
  // the caller 503s instead of silently billing the shared key. See header.
  if (firmId && env.BETA_FIRM_ID && firmId === env.BETA_FIRM_ID) {
    return env.ANTHROPIC_API_KEY ?? null
  }
  return null
}

// T32 PR-B (2026-05-23) — Deepgram per-user key resolution. Env fallback
// removed after Sandy's row landed in user_credentials. Missing key now
// returns null; callers (transcribe-job) fail with deepgram_key_missing.
// flyctl secrets unset DEEPGRAM_API_KEY runs after this deploys.
export async function resolveDeepgramKey(
  env: GatewayEnv,
  userId: string,
): Promise<string | null> {
  return resolveProviderKeyFromDb(env, userId, 'deepgram')
}

// T33 (2026-05-23) — per-user keys for OpenAI / Exa / WebShare. Nothing
// on the gateway calls these today; the keys are pre-plumbed for T3
// (enrichment relocation), which is the only future caller that
// benefits. No env fallbacks: these providers have never had gateway
// env vars, and adding one would be a multi-tenant trap.

export async function resolveOpenAiKey(
  env: GatewayEnv,
  userId: string,
): Promise<string | null> {
  return resolveProviderKeyFromDb(env, userId, 'openai')
}

export async function resolveExaKey(
  env: GatewayEnv,
  userId: string,
): Promise<string | null> {
  return resolveProviderKeyFromDb(env, userId, 'exa')
}

export async function resolveWebShareKey(
  env: GatewayEnv,
  userId: string,
): Promise<string | null> {
  return resolveProviderKeyFromDb(env, userId, 'webshare')
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
