// POST /mcp — Fastify route that mounts the MCP Streamable HTTP
// transport per-request and delegates to a fresh McpServer instance.
//
// V1 runs in stateless mode (each POST is self-contained). Stateful
// sessions (keyed by `Mcp-Session-Id`) would move to a per-session
// cache, but for slice 8 the simpler stateless pattern is enough —
// the tools themselves are stateless (pure functions of the db +
// userId + input) so there's nothing to cache between requests.

import type { FastifyInstance } from 'fastify'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'
import { Sentry } from '../sentry'
import { buildMcpServer } from './server'
import { verifyOAuthBearer } from './oauth-auth'

export async function registerMcpRoute(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  if (!env.CYGGIE_MCP_ENABLED) {
    // Feature flag off: don't register the route at all. The default 404
    // handler will surface the right envelope to callers.
    app.log.info({ flag: 'CYGGIE_MCP_ENABLED' }, 'MCP route disabled by feature flag')
    return
  }

  // Single Postgres pool reuse — matches the existing routes pattern.
  const db = getDb(env.GATEWAY_DATABASE_URL)

  app.route({
    method: 'POST',
    url: '/mcp',
    // No Zod schema here: the MCP SDK validates the JSON-RPC payload
    // itself against its own protocol schema. Fastify just hands the
    // parsed body through.
    handler: async (req, reply) => {
      // Sentry breadcrumb on every entry (per plan observability spec).
      Sentry.addBreadcrumb({
        category: 'mcp-request',
        level: 'info',
        message: 'POST /mcp',
        data: {
          method: req.method,
          ua: req.headers['user-agent'],
          // Authorization header is sanitized — we never log the actual
          // bearer token, just whether it was present.
          has_auth: typeof req.headers['authorization'] === 'string',
        },
      })

      // Slice 9: OAuth bearer-token validation (replaces slice 8 dev-bypass).
      // The token must have at least the `cyggie:read` scope — all V1
      // tools fall under read access; SQL tool (slice 10) will require
      // `cyggie:sql` separately at the tool-call layer.
      const auth = await verifyOAuthBearer(req, env, {
        requiredScopes: ['cyggie:read'],
      })
      if (!auth.ok) {
        req.log.warn(
          {
            metric: 'mcp.auth.fail',
            error_code: auth.errorCode,
            ua: req.headers['user-agent'],
          },
          'mcp request auth failed',
        )
        // Match the existing gateway error envelope shape exactly
        // (api-gateway/src/plugins/error.ts). Streamable HTTP clients
        // accept plain JSON here; the MCP transport only takes over
        // once we hand it the request.
        return reply
          .status(auth.statusCode)
          .header(
            'WWW-Authenticate',
            auth.errorCode === 'INSUFFICIENT_SCOPE'
              ? 'Bearer error="insufficient_scope", scope="cyggie:read"'
              : 'Bearer error="invalid_token"',
          )
          .send({
            error: {
              code: auth.errorCode,
              message: auth.message,
            },
          })
      }

      // Per-request server + transport. Stateless mode = no session id.
      const server = buildMcpServer({
        db,
        userId: auth.userId,
        log: req.log,
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      // Wire SDK lifecycle. Errors bubble to Sentry; close handler is a
      // no-op since stateless mode has no per-session state to clean up.
      transport.onerror = (err) => {
        req.log.error({ err }, 'mcp transport error')
        Sentry.captureException(err, {
          tags: { mcp_phase: 'transport' },
          user: { id: auth.userId },
        })
      }

      await server.connect(transport)

      // Fastify owns the response unless we hijack. The SDK writes the
      // JSON-RPC reply (and any SSE frames if the client requested
      // streaming) directly to `res.raw`, so hand off control here.
      reply.hijack()
      await transport.handleRequest(req.raw, reply.raw, req.body)
    },
  })

  app.log.info({ url: '/mcp' }, 'MCP route registered')
}
