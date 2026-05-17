import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_device_idx').on(t.deviceId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
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
