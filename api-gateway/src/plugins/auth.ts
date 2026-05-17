import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { verifyAccessToken, type AccessTokenClaims } from '../auth/jwt'
import { GatewayError } from './error'
import type { GatewayEnv } from '../env'

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

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      req.user = null
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      req.user = null
      return
    }
    try {
      req.user = await verifyAccessToken(opts.env.JWT_SIGNING_SECRET, token)
    } catch {
      // Bad token = unauthenticated. Don't throw here — let the route decide
      // (some routes are public). Health endpoints don't require auth.
      req.user = null
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
