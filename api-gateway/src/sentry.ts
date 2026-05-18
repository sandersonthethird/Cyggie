import * as Sentry from '@sentry/node'

// Initializes the Sentry SDK. MUST be imported (side-effect) before Fastify
// boots — otherwise the SDK misses errors thrown during plugin registration.
//
// No-op when SENTRY_DSN is unset so local dev without a DSN stays clean and
// CI doesn't ship events to a real inbox.
//
// What we capture:
//   • Unhandled exceptions in route handlers (via plugins/error.ts INTERNAL_ERROR)
//   • Boot failures (server.ts wraps main().catch with captureException)
//   • Synthetic events from /_debug/sentry-test (dev-only smoke test)
//
// What we deliberately do NOT capture:
//   • GatewayError 4xx/5xx — those are expected client/business errors; we add
//     them as breadcrumbs so they show context on a later real error.
//
// PII / secret hygiene: beforeSend strips OAuth-flow secrets (refresh_token,
// code_verifier, code) and auth headers (Authorization, Cookie) so events
// reaching the inbox never carry credentials.

let initialized = false

export function initSentry(): void {
  if (initialized) return
  const dsn = process.env['SENTRY_DSN']
  if (!dsn) return

  const env = process.env['NODE_ENV'] ?? 'development'
  const release = process.env['SENTRY_RELEASE'] ?? 'development-local'

  Sentry.init({
    dsn,
    environment: env,
    release,
    tracesSampleRate: env === 'production' ? 0.1 : 0,
    beforeSend(event) {
      // Strip auth + cookie headers.
      if (event.request?.headers) {
        const headers = event.request.headers as Record<string, string>
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase()
          if (lower === 'authorization' || lower === 'cookie') {
            headers[key] = '[scrubbed]'
          }
        }
      }
      // Strip OAuth-flow secrets from request bodies.
      if (event.request?.data && typeof event.request.data === 'object') {
        const data = event.request.data as Record<string, unknown>
        for (const key of ['refresh_token', 'code_verifier', 'code', 'client_secret']) {
          if (key in data) data[key] = '[scrubbed]'
        }
      }
      return event
    },
  })
  initialized = true
}

initSentry()

export { Sentry }
