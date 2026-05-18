// Sentry init MUST be the first import — its side-effect Sentry.init() must
// run before Fastify wires any handlers.
import { Sentry } from './sentry'
import { loadEnv } from './env'
import { closeDb } from './db'
import { buildApp } from './app'

async function main() {
  const env = loadEnv()
  const app = await buildApp(env)

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
}

main().catch((err) => {
  console.error('fatal:', err)
  // Boot failures bypass the Fastify error handler — capture them directly so
  // they still hit the Sentry inbox.
  Sentry.captureException(err, { tags: { source: 'boot' } })
  Sentry.flush(2000).finally(() => process.exit(1))
})
