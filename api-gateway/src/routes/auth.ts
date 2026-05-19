import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { and, eq, isNull } from 'drizzle-orm'
import {
  buildAuthUrl,
  createOAuthClient,
  exchangeCodeForTokens,
  fetchGoogleIdentity,
} from '../auth/google'
import { signAccessToken } from '../auth/jwt'
import { consumePending, generatePkcePair, generateState, rememberPending } from '../auth/pending'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { getDb } from '../db'
import { createHash, randomBytes } from 'node:crypto'

interface AuthRouteDeps {
  env: GatewayEnv
}

// Auth routes per plan-ceo-review §6 + plan-eng-review.
//
//   POST /auth/google/start  — public; returns { authUrl, state }
//   GET  /auth/google/callback — public; Google's redirect target; ends in 302
//                                to MOBILE_DEEP_LINK_BASE with the JWT
//   GET  /auth/me            — authed; returns the current user profile
//   POST /auth/logout        — authed; revokes the current session
export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { env } = deps
  const oauth = createOAuthClient({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  })

  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'POST',
    url: '/auth/google/start',
    schema: {
      body: z.object({
        device_id: z.string().min(8).max(64),
        device_label: z.string().max(200).optional(),
        // 'mobile' (default) → callback 302s to MOBILE_DEEP_LINK_BASE.
        // 'desktop'           → callback 302s to DESKTOP_DEEP_LINK_BASE.
        // Stored on the oauth_pending row so the callback handler can branch
        // without state in the gateway process (we run 2 Fly machines).
        redirect_target: z.enum(['mobile', 'desktop']).optional(),
      }),
      response: {
        200: z.object({ authUrl: z.string(), state: z.string() }),
      },
    },
    handler: async (req) => {
      const { device_id, device_label, redirect_target } = req.body
      const state = generateState()
      const { codeVerifier, codeChallenge } = generatePkcePair()
      await rememberPending({
        databaseUrl: env.GATEWAY_DATABASE_URL,
        state,
        codeVerifier,
        deviceId: device_id,
        deviceLabel: device_label ?? null,
        redirectTarget: redirect_target ?? 'mobile',
      })
      const authUrl = buildAuthUrl({ client: oauth, state, codeChallenge })
      req.log.info(
        { device_id, redirect_target: redirect_target ?? 'mobile', state: state.slice(0, 8) + '…' },
        'oauth start',
      )
      return { authUrl, state }
    },
  })

  fastifyTyped.route({
    method: 'GET',
    url: '/auth/google/callback',
    schema: {
      querystring: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    handler: async (req, reply) => {
      const { code, state, error } = req.query

      // User cancelled or Google errored out.
      if (error) {
        req.log.warn({ error }, 'oauth callback error')
        return reply.redirect(`${env.MOBILE_DEEP_LINK_BASE}?error=${encodeURIComponent(error)}`)
      }
      if (!code || !state) {
        throw new GatewayError({
          statusCode: 400,
          code: 'OAUTH_MISSING_PARAMS',
          message: 'OAuth callback missing code or state',
        })
      }

      const pending = await consumePending({
        databaseUrl: env.GATEWAY_DATABASE_URL,
        state,
      })
      if (!pending) {
        throw new GatewayError({
          statusCode: 400,
          code: 'OAUTH_STATE_INVALID',
          message: 'OAuth state is unknown or expired (5 min TTL)',
        })
      }

      // Exchange code for Google tokens.
      const googleTokens = await exchangeCodeForTokens({
        client: oauth,
        code,
        codeVerifier: pending.codeVerifier,
      })

      // Decode id_token to identify the user.
      const identity = await fetchGoogleIdentity({
        client: oauth,
        idToken: googleTokens.idToken,
        expectedAudience: env.GOOGLE_CLIENT_ID,
      })

      const db = getDb(env.GATEWAY_DATABASE_URL)

      // Upsert the user row, keyed by google_sub.
      const existingUser = await db.query.users.findFirst({
        where: eq(schema.users.googleSub, identity.googleSub),
      })

      let userId: string
      // firm_id and role come from the user row: NULL/'member' on first sign-in,
      // populated once the user completes Flow A/B/C. The cyggie:// redirect
      // below uses firm_id to decide which onboarding action to surface on mobile.
      let userFirmId: string | null
      let userRole: 'admin' | 'member'
      if (existingUser) {
        userId = existingUser.id
        userFirmId = existingUser.firmId
        userRole = existingUser.role === 'admin' ? 'admin' : 'member'
        await db
          .update(schema.users)
          .set({
            email: identity.email,
            displayName: identity.name ?? existingUser.displayName,
            avatarUrl: identity.picture ?? existingUser.avatarUrl,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, userId))
      } else {
        userId = createId()
        userFirmId = null
        userRole = 'member'
        await db.insert(schema.users).values({
          id: userId,
          googleSub: identity.googleSub,
          email: identity.email,
          displayName: identity.name,
          avatarUrl: identity.picture,
        })
      }

      // Persist Google tokens. We store access_token in plaintext (short-lived,
      // ~1 hour) and refresh_token encrypted-at-rest. For V1 dev the encryption
      // is a placeholder — TODO before production: wrap with a KMS key fetched
      // from Fly secrets. The DB-stored value is hex(sha256(refresh)+iv+ciphertext).
      const refreshTokenForStorage = googleTokens.refreshToken
        ? hashForStorage(googleTokens.refreshToken)
        : null
      const oauthTokenId = createId()
      // Idempotent upsert keyed on (user_id, provider).
      const existingOauth = await db.query.oauthTokens.findFirst({
        where: eq(schema.oauthTokens.userId, userId),
      })
      if (existingOauth) {
        await db
          .update(schema.oauthTokens)
          .set({
            accessToken: googleTokens.accessToken,
            accessTokenExpiresAt: googleTokens.expiryDate,
            refreshTokenEncrypted: refreshTokenForStorage ?? existingOauth.refreshTokenEncrypted,
            scopes: googleTokens.scope.split(' '),
            needsReauth: false,
            lastRefreshedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.oauthTokens.id, existingOauth.id))
      } else {
        await db.insert(schema.oauthTokens).values({
          id: oauthTokenId,
          userId,
          provider: 'google',
          accessToken: googleTokens.accessToken,
          accessTokenExpiresAt: googleTokens.expiryDate,
          refreshTokenEncrypted: refreshTokenForStorage,
          scopes: googleTokens.scope.split(' '),
          lastRefreshedAt: new Date(),
        })
      }

      // Create a session row. The refresh token is what mobile uses to mint
      // new access tokens; we store only its hash on the server.
      const sessionId = createId()
      const refreshToken = randomRefreshToken()
      const refreshTokenHash = hashForStorage(refreshToken)
      const refreshTtlDays = 30
      await db.insert(schema.sessions).values({
        id: sessionId,
        userId,
        deviceId: pending.deviceId,
        deviceLabel: pending.deviceLabel,
        refreshTokenHash,
        expiresAt: new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(),
      })

      // Audit.
      await db.insert(schema.auditLog).values({
        userId,
        deviceId: pending.deviceId,
        eventType: existingUser ? 'oauth.signin' : 'oauth.signup',
        actor: 'user',
        details: { provider: 'google', scopes: googleTokens.scope.split(' ') },
      })

      // Mint our own JWT for mobile to use as `Authorization: Bearer <jwt>`.
      const accessToken = await signAccessToken(env.JWT_SIGNING_SECRET, {
        sub: userId,
        sid: sessionId,
        device: pending.deviceId,
        scope: ['user'],
        firm_id: userFirmId,
        role: userRole,
      })

      // Build the onboarding action hint so mobile knows which screen to show.
      //
      //   firm_id set                            → 'returning'  (route to Calendar)
      //   firm_id null + pending invite for email → 'join_firm' (route to confirm-
      //     join screen; mobile may have the raw invite token stashed from a
      //     cyggie://invite/<token> magic link tap that kicked off OAuth)
      //   firm_id null + no pending invite       → 'create_workspace' (Flow A)
      //
      // Flow C (domain auto-join) is deferred to M6 — when it lands here, this
      // block will set firm_id on the user row server-side before computing the
      // action so the returning-user path kicks in.
      let action: 'returning' | 'create_workspace' | 'join_firm' = userFirmId
        ? 'returning'
        : 'create_workspace'
      if (!userFirmId) {
        const pendingInvite = await db.query.invites.findFirst({
          where: and(
            eq(schema.invites.email, identity.email.toLowerCase()),
            isNull(schema.invites.acceptedAt),
            isNull(schema.invites.revokedAt),
          ),
        })
        if (pendingInvite && pendingInvite.expiresAt.getTime() > Date.now()) {
          action = 'join_firm'
        }
      }

      // Redirect to the deep link with the JWT, refresh token, and the
      // onboarding hint. Target chosen per the pending row's redirect_target:
      //   • 'mobile'  → MOBILE_DEEP_LINK_BASE  (default; cyggie://auth-callback)
      //   • 'desktop' → DESKTOP_DEEP_LINK_BASE (cyggie-desktop://auth-callback)
      const deepLinkBase =
        pending.redirectTarget === 'desktop'
          ? env.DESKTOP_DEEP_LINK_BASE
          : env.MOBILE_DEEP_LINK_BASE
      const dest = new URL(deepLinkBase)
      dest.searchParams.set('session', accessToken)
      dest.searchParams.set('refresh', refreshToken)
      dest.searchParams.set('user_id', userId)
      dest.searchParams.set('action', action)
      // Surface the verified Google email to the client so the renderer's
      // "Connected as sandy@…" pill can render without a follow-up /auth/me
      // round-trip. The email is already validated against Google's id_token
      // signature above (fetchGoogleIdentity), so this isn't a new trust
      // boundary — just shortening the path.
      dest.searchParams.set('email', identity.email)
      req.log.info(
        {
          userId,
          deviceId: pending.deviceId,
          action,
          redirectTarget: pending.redirectTarget,
        },
        'oauth callback complete',
      )
      return reply.redirect(dest.toString())
    },
  })

  fastifyTyped.route({
    method: 'GET',
    url: '/auth/me',
    schema: {
      response: {
        200: z.object({
          id: z.string(),
          email: z.string(),
          displayName: z.string().nullable(),
          avatarUrl: z.string().nullable(),
          firmId: z.string().nullable(),
          role: z.enum(['admin', 'member']),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireUser()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.sub) })
      if (!row) {
        throw new GatewayError({
          statusCode: 401,
          code: 'USER_NOT_FOUND',
          message: 'User in token no longer exists',
        })
      }
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        firmId: row.firmId,
        role: row.role === 'admin' ? ('admin' as const) : ('member' as const),
      }
    },
  })

  fastifyTyped.route({
    method: 'POST',
    url: '/auth/refresh',
    schema: {
      body: z.object({
        refresh_token: z.string().min(1),
        device_id: z.string().min(8).max(64),
      }),
      response: {
        200: z.object({
          access_token: z.string(),
          refresh_token: z.string(),
          user_id: z.string(),
        }),
      },
    },
    handler: async (req) => {
      // Refresh token rotation: client presents old refresh, gateway issues a new
      // access JWT + new refresh (and revokes the old refresh in the same row by
      // replacing its hash). Per plan §6 — 30-day refresh window, rotated each use.
      const { refresh_token, device_id } = req.body
      const refreshHash = createHash('sha256').update(refresh_token).digest('hex')
      const db = getDb(env.GATEWAY_DATABASE_URL)

      const session = await db.query.sessions.findFirst({
        where: eq(schema.sessions.refreshTokenHash, refreshHash),
      })
      if (!session || session.revokedAt) {
        throw new GatewayError({
          statusCode: 401,
          code: 'INVALID_REFRESH',
          message: 'Refresh token unknown or revoked',
          reauthRequired: true,
        })
      }
      if (session.deviceId !== device_id) {
        throw new GatewayError({
          statusCode: 401,
          code: 'DEVICE_MISMATCH',
          message: 'Refresh token does not belong to this device',
          reauthRequired: true,
        })
      }
      if (session.expiresAt.getTime() < Date.now()) {
        throw new GatewayError({
          statusCode: 401,
          code: 'REFRESH_EXPIRED',
          message: 'Refresh token has expired — sign in again',
          reauthRequired: true,
        })
      }

      // Rotate. New refresh token, new hash, extended expiry, lastSeenAt updated.
      const newRefresh = randomBytes(32).toString('base64url')
      const newHash = hashForStorage(newRefresh)
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      await db
        .update(schema.sessions)
        .set({
          refreshTokenHash: newHash,
          expiresAt: newExpiry,
          lastSeenAt: new Date(),
        })
        .where(eq(schema.sessions.id, session.id))

      // Re-read the user row so the new JWT picks up the latest firm_id + role
      // (e.g. user just completed Flow A and now has a firm_id).
      const userRow = await db.query.users.findFirst({
        where: eq(schema.users.id, session.userId),
      })
      if (!userRow) {
        throw new GatewayError({
          statusCode: 401,
          code: 'USER_NOT_FOUND',
          message: 'User in session no longer exists',
          reauthRequired: true,
        })
      }

      const accessToken = await signAccessToken(env.JWT_SIGNING_SECRET, {
        sub: session.userId,
        sid: session.id,
        device: session.deviceId,
        scope: ['user'],
        firm_id: userRow.firmId,
        role: userRow.role === 'admin' ? 'admin' : 'member',
      })

      return {
        access_token: accessToken,
        refresh_token: newRefresh,
        user_id: session.userId,
      }
    },
  })

  fastifyTyped.route({
    method: 'POST',
    url: '/auth/logout',
    schema: {
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const user = req.requireUser()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      await db
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(eq(schema.sessions.id, user.sid))
      await db.insert(schema.auditLog).values({
        userId: user.sub,
        deviceId: user.device,
        eventType: 'oauth.logout',
        actor: 'user',
      })
      return { ok: true as const }
    },
  })
}

// Random base64url refresh token. 32 bytes of entropy.
function randomRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

// SHA-256 hex digest. We never store raw refresh tokens / Google refresh tokens —
// only their hash. Mobile presents the raw value, gateway compares with the hash.
function hashForStorage(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
