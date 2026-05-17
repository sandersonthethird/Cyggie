import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getPool } from '../db'
import type { GatewayEnv } from '../env'

export async function registerHealthRoutes(app: FastifyInstance, env: GatewayEnv): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // Liveness — process is up, can respond. No external dependencies.
  fastifyTyped.route({
    method: 'GET',
    url: '/health',
    schema: {
      response: { 200: z.object({ status: z.literal('ok'), uptime_s: z.number() }) },
    },
    handler: async () => ({ status: 'ok' as const, uptime_s: process.uptime() }),
  })

  // Readiness — DB reachable, ready to serve traffic. Used by Fly load balancer
  // to determine when a new instance is ready.
  fastifyTyped.route({
    method: 'GET',
    url: '/health/ready',
    schema: {
      response: {
        200: z.object({ status: z.literal('ready'), db_ms: z.number() }),
        503: z.object({ status: z.literal('degraded'), reason: z.string() }),
      },
    },
    handler: async (_req, reply) => {
      const start = Date.now()
      try {
        const pool = getPool(env.GATEWAY_DATABASE_URL)
        await pool.query('SELECT 1')
        return { status: 'ready' as const, db_ms: Date.now() - start }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.status(503).send({ status: 'degraded' as const, reason: msg })
      }
    },
  })
}
