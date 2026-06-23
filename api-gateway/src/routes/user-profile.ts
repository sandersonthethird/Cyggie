import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { GatewayEnv } from '../env'
import { getDb } from '../db'

// =============================================================================
// /user/profile — push the desktop user's identity fields (firstName,
// lastName, title, jobFunction) to Neon (T25).
//
// Desktop is the source of truth (the user edits these in desktop Settings).
// `users` is intentionally OUTSIDE the outbox/sync (it's auth/identity
// metadata, not owned content), so it uses the same dedicated-push pattern as
// API keys (PUT /user-credentials/:provider). The enhance route reads these
// to build the summarizer's task-attribution context so a gateway summary
// matches the desktop summary verbatim.
//
// Idempotent: a full-row UPDATE of the caller's own row (user.sub). All four
// fields are optional — desktop sends whatever it has; null clears.
// =============================================================================

const ProfileSchema = z.object({
  firstName: z.string().max(200).nullable().optional(),
  lastName: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  jobFunction: z.string().max(200).nullable().optional(),
})

export async function registerUserProfileRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'PATCH',
    url: '/user/profile',
    schema: {
      body: ProfileSchema,
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { firstName, lastName, title, jobFunction } = req.body

      // Only set the keys the caller actually sent (PATCH semantics): an
      // omitted field is left untouched; an explicit null clears it.
      const set: Record<string, unknown> = { updatedAt: sql`NOW()` }
      if (firstName !== undefined) set['firstName'] = firstName
      if (lastName !== undefined) set['lastName'] = lastName
      if (title !== undefined) set['title'] = title
      if (jobFunction !== undefined) set['jobFunction'] = jobFunction

      await db.update(schema.users).set(set).where(eq(schema.users.id, user.sub))
      return { ok: true as const }
    },
  })
}
