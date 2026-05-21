import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { firms } from './firms'

// Multi-tenant identity. V1 has one human user but the schema is built multi-tenant
// from day one (per plan-eng-review Section 1). `user_id` foreign keys appear on every
// owned table.
//
//   AUTH STATE MACHINE (per-user):
//     [signed_out] ──google_oauth──▶ [signed_in] ──sign_out──▶ [signed_out]
//                                          │
//                                          │ refresh_token_expires_or_revoked
//                                          ▼
//                                    [needs_reauth]  (mobile/desktop shows reauth screen)
//                                          │
//                                          │ google_oauth (re-consent)
//                                          ▼
//                                    [signed_in]
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // cuid2 — generated app-side
    googleSub: varchar('google_sub', { length: 64 }).notNull(), // Google's stable user identifier
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 200 }),
    avatarUrl: text('avatar_url'),
    isActive: boolean('is_active').notNull().default(true),
    // Multi-tenant tenancy root. NULL until the user completes one of the
    // onboarding flows (A: create workspace, B: accept invite, C: domain
    // auto-join). The OAuth callback inspects this — NULL → redirect to mobile
    // with action=create_workspace; set → mint JWT and route to Calendar.
    // Lazy callback — auth.ts ↔ firms.ts is a circular module import at the type
    // level, but drizzle's `references()` only invokes the callback at table-build
    // time, after both modules have been evaluated. Safe.
    firmId: text('firm_id').references(() => firms.id, { onDelete: 'set null' }),
    // 'admin' | 'member'. First user from a firm (Flow A) becomes admin;
    // invitees default to member; admin can promote/demote via PATCH
    // /firms/me/members/:userId.
    role: varchar('role', { length: 32 }).notNull().default('member'),
    invitedByUserId: text('invited_by_user_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    // Quota tracking (per plan-ceo-review Section 3 — concurrent session limit + monthly minute quota)
    monthlyDeepgramMinutes: jsonb('monthly_deepgram_minutes').notNull().default({}),
    // Lamport clock — bumped by writeWithSync helper on every owned-row update.
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_google_sub_idx').on(t.googleSub),
    uniqueIndex('users_email_idx').on(t.email),
    // Hot path: list members of a firm.
    index('users_firm_idx').on(t.firmId),
  ],
)

// Per-device sessions. Issued after OAuth round-trip; rotated on refresh.
//
// Mobile stores access_token (JWT) in iOS Keychain with biometric gate at first issuance.
// Desktop (Phase 2) will reuse the same model — one session row per machine.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // refresh-token rotation generates new IDs
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 64 }).notNull(), // per-device persistent ID
    deviceLabel: varchar('device_label', { length: 200 }), // "Sandy's iPhone", "MacBook Pro"
    refreshTokenHash: text('refresh_token_hash').notNull(), // never store the raw token
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // M3 — APNs push registration. Set when the mobile app POSTs its device
    // token to /devices/register-push (typically right after a sign-in
    // transition). Cleared when APNs returns 410 Unregistered on a send (token
    // expired or the user uninstalled). One push token per session row; if a
    // user signs out + back in on the same device, a fresh session row gets
    // the next registered token.
    apnsDeviceToken: text('apns_device_token'),
    apnsEnvironment: varchar('apns_environment', { length: 16 }),
    apnsTokenUpdatedAt: timestamp('apns_token_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set once by POST /auth/session/claim-by-device when a mobile client
    // recovers a session whose deep-link redirect was eaten by an
    // ASWebAuthenticationSession `dismiss`. Used as a single-use claim flag
    // (claim succeeds only while NULL) so a leaked device_id can't be
    // replayed to mint additional token pairs from the same session row.
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_device_idx').on(t.deviceId),
    index('sessions_expires_idx').on(t.expiresAt),
    // Lookup-by-token for the 410 cleanup path on send failure.
    index('sessions_apns_token_idx').on(t.apnsDeviceToken),
    // Hot path for the claim-by-device recovery query — filters by
    // device_id then takes the most-recent-and-claimable row.
    index('sessions_device_created_idx').on(t.deviceId, t.createdAt),
  ],
)

// Server-side store for in-flight OAuth round-trips. Created at POST /auth/google/start;
// consumed at GET /auth/google/callback. Replaces the in-memory Map that broke
// when Fly ran 2+ machines (the /start and /callback could land on different
// instances). 5-min TTL — entries older than expires_at are discarded on read
// and periodically swept by the gateway.
//
// state is the natural PK — generated by generateState(), unique per round-trip.
export const oauthPending = pgTable(
  'oauth_pending',
  {
    state: text('state').primaryKey(),
    codeVerifier: text('code_verifier').notNull(), // PKCE verifier paired to the challenge sent to Google
    deviceId: varchar('device_id', { length: 64 }).notNull(),
    deviceLabel: varchar('device_label', { length: 200 }),
    // 'mobile' | 'desktop' — controls which DEEP_LINK_BASE the callback handler
    // redirects to after minting the JWT. Default 'mobile' for back-compat with
    // existing pending rows.
    redirectTarget: varchar('redirect_target', { length: 16 }).notNull().default('mobile'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_pending_expires_idx').on(t.expiresAt)],
)

// Per-user Google OAuth tokens. Access tokens refreshed by the gateway server-side.
// Refresh tokens may expire after ~6 months of inactivity — when that happens the
// gateway catches `invalid_grant` and surfaces `reauth_required: true` to clients.
//
// SECURITY: refresh_token_encrypted is encrypted at rest using a server-side KMS key
// (NOT stored in this DB). The decryption key lives in Fly secrets only — per plan
// "secrets via Fly secrets only, never in DB tables." Only access_token + scopes are
// kept in plaintext, and access tokens are short-lived (~1 hour).
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(), // 'google'
    accessToken: text('access_token'), // short-lived; OK in plaintext
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenEncrypted: text('refresh_token_encrypted'), // KMS-encrypted
    scopes: jsonb('scopes').notNull().default([]),
    needsReauth: boolean('needs_reauth').notNull().default(false), // set on invalid_grant
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_user_provider_idx').on(t.userId, t.provider),
    index('oauth_needs_reauth_idx').on(t.needsReauth).where(sql`${t.needsReauth} = true`),
  ],
)
