import type { FastifyError, FastifyInstance } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { Sentry } from '../sentry'

// Per the plan, gateway responses use a uniform error envelope so every client
// (mobile, web, desktop) can intercept failures in one place:
//
//   {
//     "error": { "code": "STRING", "message": "STRING", "details"?: object },
//     "reauth_required"?: true,
//     "retry_after"?: number
//   }
//
// Mobile's lib/api/client.ts inspects `reauth_required` to fire the OAuth
// re-consent flow without coupling to specific routes (per plan-ceo-review §2).

export interface GatewayErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
  reauth_required?: true
  retry_after?: number
}

/** Throw this from a route to surface a structured client-facing error. */
export class GatewayError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details: unknown
  readonly reauthRequired: boolean
  readonly retryAfter: number | undefined

  constructor(opts: {
    statusCode: number
    code: string
    message: string
    details?: unknown
    reauthRequired?: boolean
    retryAfter?: number
  }) {
    super(opts.message)
    this.statusCode = opts.statusCode
    this.code = opts.code
    this.details = opts.details
    this.reauthRequired = opts.reauthRequired ?? false
    this.retryAfter = opts.retryAfter
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Zod validation failures (route schema mismatch). 400 with the parse issues.
    if (hasZodFastifySchemaValidationErrors(err)) {
      req.log.warn({ issues: err.validation }, 'schema validation failed')
      const body: GatewayErrorBody = {
        error: {
          code: 'BAD_REQUEST',
          message: 'Request validation failed',
          details: err.validation,
        },
      }
      return reply.status(400).send(body)
    }

    if (err instanceof GatewayError) {
      req.log.warn(
        { code: err.code, statusCode: err.statusCode, details: err.details },
        err.message,
      )
      // Add breadcrumb so the next captured error has the trail of expected
      // GatewayErrors that led up to it. We deliberately do NOT capture these
      // — they're expected business errors, not bugs.
      Sentry.addBreadcrumb({
        category: 'gateway-error',
        level: err.statusCode >= 500 ? 'error' : 'warning',
        message: err.message,
        data: { code: err.code, statusCode: err.statusCode },
      })
      const body: GatewayErrorBody = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        ...(err.reauthRequired ? { reauth_required: true as const } : {}),
        ...(err.retryAfter !== undefined ? { retry_after: err.retryAfter } : {}),
      }
      return reply.status(err.statusCode).send(body)
    }

    // Fastify-thrown errors (404, 405, etc.) carry a statusCode. Surface their code
    // but always with the envelope.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      req.log.warn({ code: err.code, statusCode: err.statusCode }, err.message)
      const body: GatewayErrorBody = {
        error: {
          code: err.code ?? 'CLIENT_ERROR',
          message: err.message,
        },
      }
      return reply.status(err.statusCode).send(body)
    }

    // Anything else is an unhandled server error. Log with stack; do NOT leak it
    // to the client. Capture to Sentry with route + user context.
    req.log.error({ err }, 'unhandled error in route')
    Sentry.captureException(err, {
      tags: { code: 'INTERNAL_ERROR', route: req.routeOptions?.url ?? req.url },
      contexts: { request: { method: req.method, url: req.url } },
      user: req.user
        ? { id: req.user.sub, session_id: req.user.sid, device_id: req.user.device }
        : undefined,
    })
    const body: GatewayErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    }
    return reply.status(500).send(body)
  })

  // Override 404s to use the same envelope.
  app.setNotFoundHandler((req, reply) => {
    const body: GatewayErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url} not found`,
      },
    }
    return reply.status(404).send(body)
  })
}
