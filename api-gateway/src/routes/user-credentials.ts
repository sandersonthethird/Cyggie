import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'

// =============================================================================
// /user-credentials/:provider — T24: per-user AI provider keys.
//
// Desktop pushes the user's locally-stored API keys to the gateway via this
// route so mobile chat (which goes through the gateway) uses the SAME key
// the user already pasted in desktop Settings. Mobile never talks to this
// route — it's a desktop → gateway write only.
//
// Resolution order in chat routes (see chat.ts buildAnthropicClient):
//   1. user_credentials row for this (user, provider)
//   2. env.ANTHROPIC_API_KEY fallback (single-firm beta key)
//   3. 503 CHAT_UNAVAILABLE
//
// Why only desktop writes: desktop is the canonical source of credentials
// (user pastes there in the Settings UI). Mobile-side credential entry
// would just be a copy of the desktop value — extra friction with no
// benefit until cloud-only firms onboard (post-V1).
//
// Validation note: we trust the desktop's key contents (length / format)
// because the user explicitly pasted it. Wrong keys surface as 401s from
// the upstream provider on the next chat — that's the right signal.
// =============================================================================

// T33 widened this enum to include 'exa' and 'webshare' alongside the
// already-supported Anthropic / OpenAI / Deepgram. The Drizzle schema's
// CHECK constraint must match (see packages/db/src/schema/user_credentials.ts
// and migration 0018_user_credentials_more_providers.sql).
// 'memo' is intentionally absent — memo-writing stays desktop-only, so
// the gateway never needs to hold a per-user memo key.
const ALLOWED_PROVIDERS = ['anthropic', 'openai', 'deepgram', 'exa', 'webshare'] as const

export async function registerUserCredentialRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'PUT',
    url: '/user-credentials/:provider',
    schema: {
      params: z.object({
        provider: z.enum(ALLOWED_PROVIDERS),
      }),
      body: z.object({
        value: z.string().min(1).max(2000),
      }),
      response: {
        200: z.object({ ok: z.literal(true) }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const { provider } = req.params
      const { value } = req.body

      const db = getDb(env.GATEWAY_DATABASE_URL)
      await db
        .insert(schema.userCredentials)
        .values({ userId: user.sub, provider, value })
        .onConflictDoUpdate({
          target: [schema.userCredentials.userId, schema.userCredentials.provider],
          set: { value, updatedAt: sql`now()` },
        })

      return { ok: true as const }
    },
  })

  // DELETE handler — rotate flow: desktop pushed key, user pastes a fresh one,
  // old one becomes stale. Cleaner UX than "overwrite with empty string."
  fastifyTyped.route({
    method: 'DELETE',
    url: '/user-credentials/:provider',
    schema: {
      params: z.object({
        provider: z.enum(ALLOWED_PROVIDERS),
      }),
      response: {
        200: z.object({ ok: z.literal(true), deleted: z.boolean() }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const { provider } = req.params
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const deleted = await db
        .delete(schema.userCredentials)
        .where(
          and(
            eq(schema.userCredentials.userId, user.sub),
            eq(schema.userCredentials.provider, provider),
          ),
        )
        .returning({ userId: schema.userCredentials.userId })
      return { ok: true as const, deleted: deleted.length > 0 }
    },
  })
}
