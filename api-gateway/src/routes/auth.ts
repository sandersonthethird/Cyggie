import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { and, count, desc, eq, gt, isNull, lt } from 'drizzle-orm'
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

  // Per-device throttle for POST /auth/session/claim-by-device. The endpoint
  // is unauthenticated by design (the device has no JWT yet) and is meant for
  // a ~15 s polling burst after an ASWebAuthenticationSession dismiss. 10
  // attempts per 60 s comfortably covers a 1.5 s-interval poll with retries
  // while still cutting off a misconfigured client. Map is per-instance — we
  // run 2 Fly machines, so the effective cap is ~20/min/device; that's still
  // tight enough for this surface.
  const claimByDeviceRateLimit = new Map<string, { count: number; windowStart: number }>()
  const CLAIM_RL_WINDOW_MS = 60_000
  const CLAIM_RL_MAX = 10

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
      // If the caller is already signed in (Bearer in header — opportunistically
      // populated by plugins/auth), look up their email and pass to Google as
      // login_hint so the consent screen pre-selects their existing account.
      // Used by mobile's calendar "Reconnect Google" flow. Endpoint stays
      // publicly callable — sign-in.tsx calls it unauthenticated.
      let loginHint: string | undefined
      if (req.user) {
        const db = getDb(env.GATEWAY_DATABASE_URL)
        const row = await db.query.users.findFirst({
          where: eq(schema.users.id, req.user.sub),
          columns: { email: true },
        })
        loginHint = row?.email
      }
      const authUrl = buildAuthUrl({ client: oauth, state, codeChallenge, loginHint })
      // Log the full state (not a prefix) so we can grep the matching callback
      // log line during incident response. State isn't a secret — Google
      // echoes it back through the user-agent URL bar.
      req.log.info(
        {
          device_id,
          redirect_target: redirect_target ?? 'mobile',
          state,
          login_hint: loginHint ? 'present' : 'absent',
        },
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
        // Diagnostic SELECT so the failure mode is self-describing in logs.
        // DELETE RETURNING above already removed the row if it matched, so
        // these counts describe the rest of the table — useful for spotting
        // sweeper-related drops or duplicate-callback races.
        const db = getDb(env.GATEWAY_DATABASE_URL)
        const [{ c: total = 0 } = { c: 0 }] = await db
          .select({ c: count() })
          .from(schema.oauthPending)
        const [{ c: expired = 0 } = { c: 0 }] = await db
          .select({ c: count() })
          .from(schema.oauthPending)
          .where(lt(schema.oauthPending.expiresAt, new Date()))
        req.log.warn(
          { state, total_rows_in_table: total, expired_rows_in_table: expired },
          'oauth callback: state not found in oauth_pending',
        )
        throw new GatewayError({
          statusCode: 400,
          code: 'OAUTH_STATE_INVALID',
          message: 'OAuth state is unknown or expired (15 min TTL)',
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
      const action = await computeOnboardingAction(db, {
        firmId: userFirmId,
        email: identity.email,
      })

      // Redirect to the deep link with the JWT, refresh token, and the
      // onboarding hint. Target chosen per the pending row's redirect_target:
      //   • 'mobile'  → MOBILE_DEEP_LINK_BASE  (default; cyggie://auth-callback)
      //   • 'desktop' → /auth/desktop-handoff  (interstitial HTML page that
      //                 then triggers cyggie-desktop:// via JS — so the
      //                 browser tab isn't left in a forever-loading state
      //                 after the OS handoff prompt)
      const params = new URLSearchParams()
      params.set('session', accessToken)
      params.set('refresh', refreshToken)
      params.set('user_id', userId)
      params.set('action', action)
      // Surface the verified Google email to the client so the renderer's
      // "Connected as sandy@…" pill can render without a follow-up /auth/me
      // round-trip. The email is already validated against Google's id_token
      // signature above (fetchGoogleIdentity), so this isn't a new trust
      // boundary — just shortening the path.
      params.set('email', identity.email)

      let redirectTo: string
      if (pending.redirectTarget === 'desktop') {
        // Use a fragment (#) so the session/refresh tokens are NOT sent to
        // the server on the GET /auth/desktop-handoff request — keeps them
        // out of Fly's access logs. The page's JS reads location.hash and
        // builds the cyggie-desktop:// URL client-side.
        redirectTo = `/auth/desktop-handoff#${params.toString()}`
      } else {
        const dest = new URL(env.MOBILE_DEEP_LINK_BASE)
        for (const [k, v] of params) dest.searchParams.set(k, v)
        redirectTo = dest.toString()
      }
      req.log.info(
        {
          userId,
          deviceId: pending.deviceId,
          action,
          redirectTarget: pending.redirectTarget,
          state,
        },
        'oauth callback complete',
      )
      return reply.redirect(redirectTo)
    },
  })

  // ────────────────────────────────────────────────────────────────────────
  // Desktop OAuth handoff page. The callback above 302s here for desktop
  // sign-ins instead of straight to cyggie-desktop://, because a 302 to a
  // non-HTTP scheme leaves the browser tab in a perpetual "loading" state
  // (the browser delegates to the OS but never gets a response to render).
  //
  // Tokens arrive in the URL fragment (#session=…) so they never leave the
  // user-agent — they aren't sent on the GET /auth/desktop-handoff request
  // and don't end up in Fly access logs. Client JS reads location.hash,
  // rebuilds cyggie-desktop://auth-callback?<query>, and triggers the OS
  // handoff via window.location.href.
  // ────────────────────────────────────────────────────────────────────────
  app.route({
    method: 'GET',
    url: '/auth/desktop-handoff',
    handler: async (_req, reply) => {
      const deepLinkBase = env.DESKTOP_DEEP_LINK_BASE
      const html = renderDesktopHandoffHtml(deepLinkBase)
      return reply
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(html)
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

  // POST /auth/session/claim-by-device — recovery from ASWebAuthenticationSession dismiss.
  //
  // On iOS, the system auth session can return type='dismiss' (or 'cancel')
  // AFTER the gateway has already minted a session row and 302'd to
  // cyggie://auth-callback?session=…. The redirect never reaches the app, so
  // mobile is stuck without tokens despite a fully-successful server-side
  // OAuth. Mobile now polls this endpoint with its stable SecureStore device_id;
  // we find the most-recent claimable session for that device, mark it
  // recovered (single-use), re-mint the access JWT, and rotate the refresh
  // token. The original refresh token (lost in the dismissed redirect) is
  // orphaned by the rotation.
  //
  // Authorization model: no JWT (the whole point is the device doesn't have
  // one). The device_id is a 32-byte SecureStore secret on the device. We add
  // belt-and-suspenders:
  //   • 120 s freshness window — sessions older than that can't be claimed,
  //     so a stolen device_id can't be replayed against historic logins.
  //   • single-use claim — recovered_at is set atomically; a second poll
  //     returns 404 even if it knows the device_id.
  //   • per-device rate limit — 10 attempts/min, returning 429.
  //   • rotation — even on legitimate recovery, the refresh token rotates,
  //     so a duplicate that leaked alongside the device_id is invalidated.
  fastifyTyped.route({
    method: 'POST',
    url: '/auth/session/claim-by-device',
    schema: {
      body: z.object({
        device_id: z.string().min(8).max(64),
      }),
      response: {
        200: z.object({
          session: z.string(),
          refresh: z.string(),
          user_id: z.string(),
          action: z.enum(['returning', 'create_workspace', 'join_firm']),
          email: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const { device_id } = req.body

      // Per-device throttle.
      const now = Date.now()
      const bucket = claimByDeviceRateLimit.get(device_id)
      if (!bucket || now - bucket.windowStart > CLAIM_RL_WINDOW_MS) {
        claimByDeviceRateLimit.set(device_id, { count: 1, windowStart: now })
      } else {
        bucket.count += 1
        if (bucket.count > CLAIM_RL_MAX) {
          throw new GatewayError({
            statusCode: 429,
            code: 'RATE_LIMITED',
            message: 'Too many claim attempts for this device — wait a minute',
          })
        }
      }

      const db = getDb(env.GATEWAY_DATABASE_URL)
      const freshnessCutoff = new Date(Date.now() - 120_000)

      // Find the most-recent claimable session, then atomically mark it
      // recovered. The UPDATE's `recovered_at IS NULL` predicate closes the
      // TOCTOU between two concurrent polls — only one returns rows.
      const candidate = await db.query.sessions.findFirst({
        where: and(
          eq(schema.sessions.deviceId, device_id),
          isNull(schema.sessions.revokedAt),
          isNull(schema.sessions.recoveredAt),
          gt(schema.sessions.createdAt, freshnessCutoff),
        ),
        orderBy: [desc(schema.sessions.createdAt)],
      })
      if (!candidate) {
        throw new GatewayError({
          statusCode: 404,
          code: 'NO_RECENT_SESSION',
          message: 'No claimable session for this device',
        })
      }

      const newRefresh = randomRefreshToken()
      const newRefreshHash = hashForStorage(newRefresh)
      const claimed = await db
        .update(schema.sessions)
        .set({
          recoveredAt: new Date(),
          refreshTokenHash: newRefreshHash,
          lastSeenAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessions.id, candidate.id),
            isNull(schema.sessions.recoveredAt),
          ),
        )
        .returning({ id: schema.sessions.id, userId: schema.sessions.userId })
      if (claimed.length === 0) {
        // Lost the race to a concurrent poll. Treat as "nothing to claim".
        throw new GatewayError({
          statusCode: 404,
          code: 'NO_RECENT_SESSION',
          message: 'No claimable session for this device',
        })
      }

      const session = claimed[0]!
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
        device: device_id,
        scope: ['user'],
        firm_id: userRow.firmId,
        role: userRow.role === 'admin' ? 'admin' : 'member',
      })

      const action = await computeOnboardingAction(db, {
        firmId: userRow.firmId,
        email: userRow.email,
      })

      await db.insert(schema.auditLog).values({
        userId: session.userId,
        deviceId: device_id,
        eventType: 'oauth.recovered',
        actor: 'user',
      })

      req.log.info(
        { userId: session.userId, deviceId: device_id, sessionId: session.id, action },
        'oauth session recovered via claim-by-device',
      )

      return {
        session: accessToken,
        refresh: newRefresh,
        user_id: session.userId,
        action,
        email: userRow.email,
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

// Onboarding action surfaced to mobile in the cyggie:// redirect and in the
// claim-by-device recovery response. Kept in one place so the OAuth callback
// and the recovery endpoint can't drift.
//
//   firm_id set                              → 'returning'         (Calendar)
//   firm_id null + live invite for email     → 'join_firm'         (confirm-join)
//   firm_id null + no live invite            → 'create_workspace'  (Flow A)
//
// Flow C (domain auto-join) lands in M6 by setting firm_id on the user row
// before this runs; the returning-user branch then takes over.
async function computeOnboardingAction(
  db: ReturnType<typeof getDb>,
  user: { firmId: string | null; email: string },
): Promise<'returning' | 'create_workspace' | 'join_firm'> {
  if (user.firmId) return 'returning'
  const pendingInvite = await db.query.invites.findFirst({
    where: and(
      eq(schema.invites.email, user.email.toLowerCase()),
      isNull(schema.invites.acceptedAt),
      isNull(schema.invites.revokedAt),
    ),
  })
  if (pendingInvite && pendingInvite.expiresAt.getTime() > Date.now()) {
    return 'join_firm'
  }
  return 'create_workspace'
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

// Self-contained HTML for /auth/desktop-handoff. No template engine, no
// external assets — single response, fully inline. The deep-link base is
// JSON-encoded into a string literal so any future scheme change (e.g.
// cyggie-desktop:// → cyggie-app://) requires only an env update.
function renderDesktopHandoffHtml(deepLinkBase: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signing into Cyggie…</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #f7f8fa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1f2933; }
  .wrap { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border: 1px solid #e4e7eb; border-radius: 12px;
    padding: 32px 36px; max-width: 380px; text-align: center;
    box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  p  { font-size: 14px; line-height: 1.5; margin: 0; color: #52606d; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #cbd2d9;
    border-top-color: #1f2933; border-radius: 50%; vertical-align: -2px; margin-right: 8px;
    animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1 id="title"><span class="spin" id="spinner"></span>Signing you into Cyggie…</h1>
    <p id="msg">Hold on — opening the Cyggie app.</p>
  </div>
</div>
<script>
(function(){
  var DEEP_LINK_BASE = ${JSON.stringify(deepLinkBase)};
  var hash = location.hash && location.hash.length > 1 ? location.hash.substring(1) : '';
  if (hash) {
    // Trigger the OS handoff. Slight delay so the page paints first — no flicker.
    setTimeout(function(){
      window.location.href = DEEP_LINK_BASE + '?' + hash;
    }, 80);
  }
  // Whether the handoff fires or not, swap the message after ~2s so the user
  // sees a "you can close this tab" affordance instead of an infinite spinner.
  setTimeout(function(){
    var s = document.getElementById('spinner'); if (s) s.style.display = 'none';
    var t = document.getElementById('title'); if (t) t.textContent = 'Cyggie is signed in';
    var m = document.getElementById('msg'); if (m) m.textContent = 'You can close this tab.';
  }, 2000);
})();
</script>
</body>
</html>`
}
