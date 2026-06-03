// node-oidc-provider configuration for External Agents V1 slice 9.
//
// Cyggie acts as a pure OAuth 2.0 authorization server — no ID tokens,
// no userinfo endpoint, no OIDC discovery. Access tokens are JWT
// (HS256, signed with the existing JWT_SIGNING_SECRET) so the MCP route
// can verify without touching the adapter on every request.
//
// Three grant types enabled:
//   - authorization_code + PKCE — interactive clients (Claude Desktop,
//     Cursor, browser extensions)
//   - client_credentials — server-side / service-account clients (the
//     Slack bot once it splits out in multi-firm)
//   - refresh_token — rotation built into the library
//
// Three scopes: cyggie:read, cyggie:ask (reserved), cyggie:sql. The
// access token's `scope` claim is what the MCP route checks against
// per-tool scope requirements.

import { createSecretKey, generateKeyPairSync } from 'node:crypto'
import { Provider } from 'oidc-provider'
import type { Configuration } from 'oidc-provider'
import { exportJWK } from 'jose'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { DrizzleAdapter } from './adapter'
import type { getDb } from '../db'
import type { GatewayEnv } from '../env'

export const OAUTH_SCOPES = ['cyggie:read', 'cyggie:ask', 'cyggie:sql'] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]

// node-oidc-provider requires at least one asymmetric key in its JWKS
// even if we're OAuth-only and never use it. We generate an ephemeral
// Ed25519 keypair at boot — it's never used because access tokens are
// HS256-signed via the resourceIndicators path. Regenerating on each
// restart is fine since nothing depends on the key persistence.
//
// Slice 9 follow-up: if we ever enable OIDC (ID tokens), this needs to
// move to a persisted key in env / KMS so existing tokens stay valid
// across restarts.
async function generateEphemeralJwks() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = await exportJWK(privateKey)
  jwk.alg = 'EdDSA'
  jwk.use = 'sig'
  jwk.kid = 'ephemeral-ed25519'
  return [jwk]
}

export interface OAuthProviderArgs {
  env: GatewayEnv
  db: ReturnType<typeof getDb>
  // Where the gateway is reachable. Determines the issuer URL and the
  // `iss` claim in every JWT. Production: https://cyggie-gateway.fly.dev.
  // Dev: http://127.0.0.1:8443.
  issuer: string
}

export async function buildOAuthProvider(args: OAuthProviderArgs): Promise<Provider> {
  const { env, db, issuer } = args
  const ephemeralJwks = await generateEphemeralJwks()
  const hs256Key = createSecretKey(Buffer.from(env.JWT_SIGNING_SECRET, 'utf-8'))

  const configuration: Configuration = {
    adapter: (name) => new DrizzleAdapter(name, db),
    scopes: [...OAUTH_SCOPES],
    // We don't issue ID tokens. Empty claims map = OIDC userinfo
    // endpoint returns minimal payload; we disable it below anyway.
    claims: {},
    // Cookie signing keys — reuse the JWT signer to avoid managing a
    // separate keychain. The cookie is only used for the consent
    // session (browser-only), not for API auth.
    cookies: { keys: [env.JWT_SIGNING_SECRET] },
    jwks: { keys: ephemeralJwks },
    // Per plan decision-log #10: JWT access tokens, 15-min TTL.
    // Refresh tokens 30-day TTL, opaque (library default).
    ttl: {
      AccessToken: 15 * 60,
      RefreshToken: 30 * 24 * 60 * 60,
      AuthorizationCode: 60,
      Session: 24 * 60 * 60,
      Interaction: 60 * 60,
      Grant: 30 * 24 * 60 * 60,
    },
    // PKCE required for all auth_code flows (no exceptions). Slice 9
    // spec. node-oidc-provider only supports S256 as of v9, so the
    // method list is fixed at the library level — we just enforce
    // required.
    pkce: { required: () => true },
    // Issuer + redirect_uri policy for clients.
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
    features: {
      // Dynamic client registration (RFC 7591). The /oauth/register
      // route is rate-limited at the Fastify layer (10/hr per IP) in
      // routes.ts; the library itself doesn't rate-limit DCR.
      registration: { enabled: true },
      // Token revocation endpoint (RFC 7009).
      revocation: { enabled: true },
      // Library's built-in dev consent screen is OFF — we render our
      // own via the interactions URL below.
      devInteractions: { enabled: false },
      // No introspection — JWT access tokens self-describe and the
      // MCP route verifies them directly. Reduces surface area.
      introspection: { enabled: false },
      // No userinfo — we don't issue ID tokens.
      userinfo: { enabled: false },
      // JWT access tokens with HS256 signing. Resource server is the
      // MCP audience.
      resourceIndicators: {
        enabled: true,
        defaultResource: () => issuer,
        getResourceServerInfo: (_ctx, _resourceIndicator, _client) => ({
          audience: 'cyggie-mcp',
          accessTokenTTL: 15 * 60,
          accessTokenFormat: 'jwt',
          jwt: { sign: { alg: 'HS256', key: hs256Key, kid: 'gateway-jwt' } },
          scope: [...OAUTH_SCOPES].join(' '),
        }),
      },
      // Server-to-server grant for service accounts (Slack bot, future
      // automation tools).
      clientCredentials: { enabled: true },
    },
    // Our own consent UI lives at /oauth/interaction/:uid. The library
    // redirects the browser there during the authorize flow; the route
    // handler renders the consent screen and POSTs back with the result.
    interactions: {
      url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}`,
    },
    // Map account id to a profile the library can introspect. Used by
    // the consent screen + (in OIDC mode) the ID token / userinfo. We
    // keep claims minimal because we're OAuth-only.
    findAccount: async (_ctx, id) => {
      const rows = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          firmId: schema.users.firmId,
          displayName: schema.users.displayName,
        })
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1)
      const u = rows[0]
      if (!u) return undefined
      return {
        accountId: u.id,
        async claims() {
          return {
            sub: u.id,
            email: u.email,
            firm_id: u.firmId,
            name: u.displayName ?? undefined,
          }
        },
      }
    },
    // Rotation: library rotates on every refresh exchange by default.
    // Reuse detection: presenting a rotated token triggers revokeByGrantId
    // automatically (RFC 6749 §10.4 — the library handles this).
    rotateRefreshToken: true,
  }

  return new Provider(issuer, configuration)
}
