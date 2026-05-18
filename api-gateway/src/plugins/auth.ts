import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { verifyAccessToken, type AccessTokenClaims } from '../auth/jwt'
import { GatewayError } from './error'
import type { GatewayEnv } from '../env'
import { Sentry } from '../sentry'

// Decorates the request with `req.user` (verified JWT claims) when an Authorization
// header is present. Routes that require auth call `req.requireUser()` which throws
// INVALID_TOKEN with reauth_required if the user isn't present.
//
// The plugin itself never throws — it just populates `req.user` if it can. Each
// route chooses whether to require it.

declare module 'fastify' {
  interface FastifyRequest {
    user: AccessTokenClaims | null
    requireUser(): AccessTokenClaims
    // Tenant guard. Throws UNAUTHENTICATED if no JWT, NO_FIRM if firm_id is null.
    // Returns claims with a narrowed firm_id type (non-null) so call sites can
    // use the value without an extra check.
    requireFirm(): AccessTokenClaims & { firm_id: string }
    // Admin guard. Throws on non-admin role. Implies requireFirm.
    requireAdmin(): AccessTokenClaims & { firm_id: string; role: 'admin' }
  }
}

interface AuthPluginOpts {
  env: GatewayEnv
}

async function authPlugin(app: FastifyInstance, opts: AuthPluginOpts): Promise<void> {
  app.decorateRequest('user', null)
  app.decorateRequest('requireUser', function requireUser(this: FastifyRequest) {
    if (!this.user) {
      throw new GatewayError({
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      })
    }
    return this.user
  })
  app.decorateRequest('requireFirm', function requireFirm(this: FastifyRequest) {
    const u = this.requireUser()
    if (!u.firm_id) {
      throw new GatewayError({
        statusCode: 403,
        code: 'NO_FIRM',
        message: 'User has not completed onboarding (no firm_id). Complete create-workspace or accept-invite first.',
      })
    }
    return u as AccessTokenClaims & { firm_id: string }
  })
  app.decorateRequest('requireAdmin', function requireAdmin(this: FastifyRequest) {
    const u = this.requireFirm()
    if (u.role !== 'admin') {
      throw new GatewayError({
        statusCode: 403,
        code: 'ADMIN_REQUIRED',
        message: 'This action requires firm admin role',
      })
    }
    return u as AccessTokenClaims & { firm_id: string; role: 'admin' }
  })

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      req.user = null
      Sentry.setUser(null)
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      req.user = null
      Sentry.setUser(null)
      return
    }
    try {
      req.user = await verifyAccessToken(opts.env.JWT_SIGNING_SECRET, token)
      Sentry.setUser({
        id: req.user.sub,
        session_id: req.user.sid,
        device_id: req.user.device,
        firm_id: req.user.firm_id ?? '(none)',
        role: req.user.role,
      })
    } catch {
      // Bad token = unauthenticated. Don't throw here — let the route decide
      // (some routes are public). Health endpoints don't require auth.
      req.user = null
      Sentry.setUser(null)
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
