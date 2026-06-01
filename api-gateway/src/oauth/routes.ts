// OAuth 2.0 route wiring (External Agents V1 slice 9).
//
// Mounts node-oidc-provider's HTTP surface under /oauth/* on the
// existing Fastify gateway. Three groups of routes:
//
//   1. /.well-known/oauth-authorization-server — RFC 8414 metadata.
//      Hand-written so MCP clients that explicitly look for this URL
//      (Claude Desktop, Cursor) get a stable document independent of
//      the library's OIDC discovery.
//
//   2. /oauth/interaction/:uid + /oauth/interaction/:uid/confirm — our
//      consent screen. Library redirects the browser here mid-flow;
//      we render an HTML page that delegates to existing Google login
//      if not signed in, otherwise asks the user to allow/deny the
//      client + scopes.
//
//   3. /oauth/* (catch-all) — every other endpoint
//      (/oauth/authorize, /oauth/token, /oauth/revoke, /oauth/register)
//      handed to provider.callback().
//
// Per plan acceptance criteria + decision-log #26, an automated E2E
// test in CI exercises the full auth-code+PKCE flow on every PR.
// See api-gateway/test/oauth-e2e.test.ts for the scaffold.

import type { FastifyInstance } from 'fastify'
import type { Provider } from 'oidc-provider'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'
import { Sentry } from '../sentry'
import { buildOAuthProvider, OAUTH_SCOPES } from './provider'
import { renderConsentScreen, renderNeedLoginScreen } from './consent'
import {
  registerOAuthRateLimiter,
  checkRegistrationRateLimit,
} from './rate-limit'
import { attachLifecycleHooks } from './hooks'

// Public scopes — exposed via metadata for clients to discover.
const ADVERTISED_SCOPES = [...OAUTH_SCOPES]
const ADVERTISED_GRANT_TYPES = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
]
const ADVERTISED_RESPONSE_TYPES = ['code']

export interface RegisterOAuthArgs {
  app: FastifyInstance
  env: GatewayEnv
  // Public-facing base URL of the gateway (no trailing slash). The
  // issuer URL is `${baseUrl}/oauth` so node-oidc-provider's routes
  // (authorize, token, etc.) end up at /oauth/authorize, /oauth/token,
  // and not conflicting with the gateway's existing /auth/google/* etc.
  baseUrl: string
}

export async function registerOAuthRoutes(args: RegisterOAuthArgs): Promise<{
  provider: Provider
}> {
  const { app, env, baseUrl } = args
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const issuer = `${baseUrl}/oauth`

  // Build the provider + attach Sentry breadcrumbs and metric logs.
  const provider = await buildOAuthProvider({ env, db, issuer })
  attachLifecycleHooks(provider, app.log)

  // node-oidc-provider proxies / behind reverse proxies (Fly's edge) —
  // tell it to trust X-Forwarded-* headers so it builds correct
  // absolute URLs in metadata + redirects.
  provider.proxy = true

  // In-memory IP-based rate limiter (10/hr per IP on /oauth/register).
  // Single-machine V1 is fine; multi-firm moves this to Redis.
  registerOAuthRateLimiter(app)

  // ─── RFC 8414 metadata ─────────────────────────────────────────────
  app.route({
    method: 'GET',
    url: '/.well-known/oauth-authorization-server',
    handler: async () => ({
      issuer,
      authorization_endpoint: `${baseUrl}/oauth/auth`,
      token_endpoint: `${baseUrl}/oauth/token`,
      revocation_endpoint: `${baseUrl}/oauth/token/revocation`,
      registration_endpoint: `${baseUrl}/oauth/reg`,
      jwks_uri: `${baseUrl}/oauth/jwks`,
      response_types_supported: ADVERTISED_RESPONSE_TYPES,
      grant_types_supported: ADVERTISED_GRANT_TYPES,
      scopes_supported: ADVERTISED_SCOPES,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none', // for PKCE public clients
      ],
      service_documentation: `${baseUrl}/mcp/README.md`,
    }),
  })

  // ─── RFC 9728 protected-resource metadata ─────────────────────────
  app.route({
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
    handler: async () => ({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ADVERTISED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl}/mcp/README.md`,
    }),
  })

  // ─── Consent UI ────────────────────────────────────────────────────
  app.route({
    method: 'GET',
    url: '/oauth/interaction/:uid',
    handler: async (req, reply) => {
      try {
        // Build a Web-Standard Request from the Fastify request so
        // provider.interactionDetails (which expects http req/res) works.
        const details = await provider.interactionDetails(req.raw, reply.raw)
        const client = await provider.Client.find(details.params['client_id'] as string)
        if (!client) {
          reply.code(400)
          return { error: { code: 'INVALID_CLIENT', message: 'Client not found' } }
        }

        if (details.prompt.name === 'login') {
          // User not signed in. V1 stub: render a "log in first" page
          // that points at the existing Google OAuth start endpoint.
          // The Google callback returns a JWT session — once present,
          // re-hitting this URL transitions to the consent prompt.
          reply.type('text/html')
          return renderNeedLoginScreen({
            interactionUid: details.uid,
            clientName: (client.clientName as string | undefined) ?? client.clientId,
            baseUrl,
          })
        }

        if (details.prompt.name === 'consent') {
          reply.type('text/html')
          const requestedScopes =
            (details.prompt.details['missingOIDCScope'] as string[] | undefined) ??
            (details.params['scope'] as string | undefined)?.split(' ') ??
            []
          return renderConsentScreen({
            interactionUid: details.uid,
            clientName: (client.clientName as string | undefined) ?? client.clientId,
            scopes: requestedScopes,
          })
        }

        reply.code(400)
        return {
          error: {
            code: 'UNSUPPORTED_INTERACTION',
            message: `Unsupported interaction prompt: ${details.prompt.name}`,
          },
        }
      } catch (err) {
        req.log.error({ err }, 'oauth interaction lookup failed')
        Sentry.captureException(err, { tags: { code: 'OAUTH_INTERACTION' } })
        throw err
      }
    },
  })

  app.route({
    method: 'POST',
    url: '/oauth/interaction/:uid/confirm',
    handler: async (req, reply) => {
      const details = await provider.interactionDetails(req.raw, reply.raw)
      // Body: { decision: 'allow' | 'deny' }
      const body = (req.body ?? {}) as { decision?: string }
      const accepted = body.decision === 'allow'

      if (!accepted) {
        // Deny — tell oidc-provider the user said no; library redirects
        // back to client with error=access_denied.
        const result = { error: 'access_denied', error_description: 'User denied consent.' }
        return provider.interactionFinished(req.raw, reply.raw, result, {
          mergeWithLastSubmission: false,
        })
      }

      // Allow — issue a Grant with the requested scopes and complete
      // the interaction. accountId comes from the OAuth session the
      // library establishes after the user signs in. V1 stub: relies
      // on the user having an existing oidc-provider Session (set up
      // by a side flow we haven't wired yet — slice 9.5 follow-up:
      // hook the Google OAuth callback to call provider.Session.find
      // and seed the session with the Cyggie user id).
      const accountId = details.session?.accountId as string | undefined
      if (!accountId) {
        reply.code(401)
        return {
          error: {
            code: 'NOT_LOGGED_IN',
            message: 'No active Cyggie session — log in first.',
          },
        }
      }

      const grant = new provider.Grant({
        accountId,
        clientId: details.params['client_id'] as string,
      })
      const requestedScope = (details.params['scope'] as string | undefined) ?? ''
      grant.addOIDCScope(requestedScope)
      grant.addResourceScope(issuer, requestedScope)
      const grantId = await grant.save()

      return provider.interactionFinished(
        req.raw,
        reply.raw,
        {
          login: { accountId },
          consent: { grantId },
        },
        { mergeWithLastSubmission: true },
      )
    },
  })

  // ─── /oauth/register — rate-limit guard before handing off ────────
  app.route({
    method: 'POST',
    url: '/oauth/reg',
    handler: async (req, reply) => {
      const ip = req.ip
      const limit = checkRegistrationRateLimit(ip)
      if (!limit.allowed) {
        reply.code(429)
        reply.header('Retry-After', String(limit.retryAfterSeconds))
        return {
          error: {
            code: 'RATE_LIMITED',
            message: `Too many registrations from this IP. Retry in ${limit.retryAfterSeconds}s.`,
          },
        }
      }
      reply.hijack()
      return provider.callback()(req.raw, reply.raw)
    },
  })

  // ─── Catch-all for everything else the library serves ─────────────
  // /oauth/auth, /oauth/token, /oauth/token/revocation, /oauth/jwks, etc.
  // More specific routes above MUST be declared first so they win.
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    url: '/oauth/*',
    handler: async (req, reply) => {
      reply.hijack()
      return provider.callback()(req.raw, reply.raw)
    },
  })

  app.log.info({ issuer }, 'OAuth 2.0 server registered')

  return { provider }
}
