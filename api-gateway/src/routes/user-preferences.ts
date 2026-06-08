import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { GatewayEnv } from '../env'
import { getDb } from '../db'

// =============================================================================
// /user/preferences — read + write the synced key/value user preferences from
// mobile/web (Part E). Desktop writes via SQLite + sync; mobile has no local DB
// so it writes Neon directly here. The same `user_preferences` table the chat
// context builder reads (e.g. `emailThreadsPerCompany`).
//
// Upsert stamps a fresh lamport (max(now, current)+1-ish via epoch ms) so a
// later /sync/push from desktop with a lower lamport loses under LWW, matching
// the sync clock's wall-clock-anchored ordering.
// =============================================================================

const PrefValueSchema = z.object({ key: z.string().min(1).max(128), value: z.string().max(4096) })

export async function registerUserPreferenceRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'GET',
    url: '/user/preferences',
    schema: {
      response: { 200: z.object({ preferences: z.record(z.string(), z.string()) }) },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const rows = await db
        .select({ key: schema.userPreferences.key, value: schema.userPreferences.value })
        .from(schema.userPreferences)
        .where(eq(schema.userPreferences.userId, user.sub))
      return { preferences: Object.fromEntries(rows.map((r) => [r.key, r.value])) }
    },
  })

  fastifyTyped.route({
    method: 'PATCH',
    url: '/user/preferences',
    schema: {
      body: PrefValueSchema,
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { key, value } = req.body
      // Wall-clock-anchored lamport so cross-device LWW orders sensibly.
      const lamport = String(Date.now())
      await db
        .insert(schema.userPreferences)
        .values({ userId: user.sub, key, value, lamport })
        .onConflictDoUpdate({
          target: [schema.userPreferences.userId, schema.userPreferences.key],
          set: { value, lamport, updatedAt: sql`NOW()` },
        })
      return { ok: true as const }
    },
  })
}
