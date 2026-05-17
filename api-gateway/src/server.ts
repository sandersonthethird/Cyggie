import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifySensible from '@fastify/sensible'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { loadEnv } from './env'
import { closeDb } from './db'
import { registerErrorHandler } from './plugins/error'
import authPlugin from './plugins/auth'
import { registerAuthRoutes } from './routes/auth'
import { registerHealthRoutes } from './routes/health'
import { registerCalendarRoutes } from './routes/calendar'

async function main() {
  const env = loadEnv()

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss', singleLine: false },
            },
          }
        : {}),
    },
    trustProxy: true, // Fly sets X-Forwarded-For
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024, // 10 MB — bigger than default for chat attachments etc.
  })

  // Zod type provider — every route's schema is parsed by zod, and the response
  // serializer uses the same schema for output validation.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Plugins
  await app.register(fastifySensible)
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // gateway serves JSON only — CSP is for HTML responses
  })
  await app.register(fastifyCors, {
    origin: true, // dev-permissive; in production, restrict to mobile app's bundle ID + future web origin
    credentials: true,
  })
  await app.register(authPlugin, { env })

  // Global error envelope (per plan §0.6 + plan-eng-review).
  registerErrorHandler(app)

  // Routes
  await registerHealthRoutes(app, env)
  await registerAuthRoutes(app, { env })
  await registerCalendarRoutes(app, env)

  // Boot
  try {
    await app.listen({ host: env.HOST, port: env.PORT })
    app.log.info(
      {
        host: env.HOST,
        port: env.PORT,
        env: env.NODE_ENV,
        oauth_redirect: env.GOOGLE_OAUTH_REDIRECT_URI,
      },
      'gateway listening',
    )
  } catch (err) {
    app.log.fatal({ err }, 'gateway failed to start')
    process.exit(1)
  }

  // Graceful shutdown — Fly sends SIGTERM with a 5-second grace period.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutdown requested')
    try {
      await app.close()
      await closeDb()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'shutdown error')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Silence unused import warning for jsonSchemaTransform (used by OpenAPI plugin
  // in a follow-up — leaves the wiring inert for now).
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  void jsonSchemaTransform
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
