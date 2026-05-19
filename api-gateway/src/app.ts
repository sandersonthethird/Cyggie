// Fastify app builder — pure construction, no `listen()`. Extracted from
// server.ts so tests can use `app.inject()` without binding a port.

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifySensible from '@fastify/sensible'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { GatewayEnv } from './env'
import { registerErrorHandler } from './plugins/error'
import authPlugin from './plugins/auth'
import { registerAuthRoutes } from './routes/auth'
import { registerHealthRoutes } from './routes/health'
import { registerCalendarRoutes } from './routes/calendar'
import { registerCompanyRoutes } from './routes/companies'
import { registerContactRoutes } from './routes/contacts'
import { registerMeetingRoutes } from './routes/meetings'
import { registerDebugRoutes } from './routes/_debug'
import { registerFirmRoutes } from './routes/firms'

export async function buildApp(env: GatewayEnv): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Tests use `silent` so unrelated test output stays clean. Dev keeps
      // pino-pretty; prod keeps plain JSON for fly logs ingestion.
      ...(env.NODE_ENV === 'test'
        ? {}
        : env.NODE_ENV === 'development'
          ? {
              transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss', singleLine: false },
              },
            }
          : {}),
    },
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV === 'test',
    bodyLimit: 10 * 1024 * 1024,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(fastifySensible)
  await app.register(fastifyHelmet, { contentSecurityPolicy: false })
  await app.register(fastifyCors, { origin: true, credentials: true })
  await app.register(authPlugin, { env })

  registerErrorHandler(app)

  await registerHealthRoutes(app, env)
  await registerAuthRoutes(app, { env })
  await registerFirmRoutes(app, { env })
  await registerCalendarRoutes(app, env)
  await registerCompanyRoutes(app, env)
  await registerContactRoutes(app, env)
  await registerMeetingRoutes(app, env)
  await registerDebugRoutes(app, env)

  return app
}
