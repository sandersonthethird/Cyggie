// Sentry init MUST be the first import — its side-effect Sentry.init() must
// run before Fastify wires any handlers.
import { Sentry } from './sentry'
import { loadEnv } from './env'
import { closeDb, getPool } from './db'
import { buildApp } from './app'
import { startPendingSweeper, stopPendingSweeper } from './auth/pending'
import { reconcileStuckJobs } from './recording/transcribe-job'
import { startStaleRecordingSweeper, stopStaleRecordingSweeper } from './recording/stale-sweeper'
import { checkOwnedTableSchemaDrift } from './sync/schema-drift'

async function main() {
  const env = loadEnv()
  const app = await buildApp(env)

  // Schema-drift guard: catch the "migration written but not applied to Neon"
  // class that silently broke all meetings sync on 2026-06-29 (see
  // sync/schema-drift.ts). Non-fatal — a false positive must not down the
  // gateway; the signal is the loud error + Sentry alert. Fire-and-forget so it
  // never delays serving traffic.
  if (env.NODE_ENV !== 'test') {
    checkOwnedTableSchemaDrift(getPool(env.GATEWAY_DATABASE_URL))
      .then((drifts) => {
        if (drifts.length === 0) return
        app.log.error(
          { drifts, metric: 'schema.drift_detected' },
          'OWNED-TABLE SCHEMA DRIFT: Neon is missing columns the Drizzle schema ' +
            'expects — sync writes to these tables WILL fail. Apply the pending migration.',
        )
        Sentry.captureMessage('owned-table schema drift detected', {
          level: 'error',
          tags: { source: 'boot', metric: 'schema.drift_detected' },
          extra: { drifts },
        })
      })
      .catch((err) => {
        app.log.error({ err }, 'schema-drift check failed to run')
      })
  }

  // Background sweeper for expired oauth_pending rows. Skipped in tests so
  // they don't leave a setInterval handle hanging.
  if (env.NODE_ENV !== 'test') {
    startPendingSweeper(env.GATEWAY_DATABASE_URL)
  }

  // Recover any transcribe jobs that were in-flight when the previous gateway
  // process died (Fly redeploy, crash, etc.). Polls Deepgram for completion;
  // self-heals to either status='transcribed' (with push) or status='error'.
  // Fire-and-forget — slow path; the gateway can serve traffic in parallel.
  if (env.NODE_ENV !== 'test') {
    reconcileStuckJobs(env).catch((err) => {
      app.log.error({ err }, 'transcribe-job reconcile failed')
    })
    // Last-resort cleanup for "stuck recording" meetings (phone crashed
    // mid-upload, Deepgram webhook never landed AND reconciler poll
    // failed). Marks rows older than 1 hour as status='error' so they
    // don't sit in limbo forever.
    startStaleRecordingSweeper(env)
  }

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
      stopPendingSweeper()
      stopStaleRecordingSweeper()
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
