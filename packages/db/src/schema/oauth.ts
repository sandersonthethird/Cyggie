// OAuth 2.0 server tables (External Agents V1 slice 9).
//
// Backs node-oidc-provider with a Drizzle-backed adapter. The library
// stores each model as a payload blob keyed by id. We split into four
// physical tables so high-value queries (admin: list registered clients;
// security: per-user grant revocation; ops: refresh rotation chain) hit
// indexed columns instead of a JSONB scan:
//
//   oauth_clients          — dynamic-client-registration records + admin-
//                             provisioned bot clients
//   oauth_grants           — user consent grants (one per user × client)
//   oauth_refresh_tokens   — opaque refresh tokens w/ rotation chain +
//                             reuse-detection state
//   oauth_payloads         — catch-all for transient oidc-provider models
//                             (Session, Interaction, AuthorizationCode,
//                              AccessToken if persisted, etc.)
//
// All four follow the same adapter contract: (name, id) → payload + ttl.
// The adapter (api-gateway/src/oauth/adapter.ts) routes by model name to
// the right table.

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { firms } from './firms'
import { users } from './auth'

// ─── Registered OAuth clients ────────────────────────────────────────────
//
// Each row is one OAuth client_id: a Claude Desktop install, the Slack bot,
// a Zapier integration, etc. DCR (RFC 7591) creates rows here; admin can
// also pre-provision via direct insert. firmId is nullable for cross-firm
// clients (e.g., a single Slack bot client used by multiple firms in V2);
// V1 single-firm beta sets it on every row.

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    payload: jsonb('payload').notNull(),
    // Surfaced for admin queries — populated from payload at upsert time
    // so we never get stale derived state. NOT generated columns (drizzle
    // ergonomics) — adapter writes these explicitly.
    clientId: text('client_id').notNull().unique(),
    clientName: text('client_name'),
    firmId: text('firm_id').references(() => firms.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('oauth_clients_firm_idx').on(t.firmId),
    index('oauth_clients_created_by_idx').on(t.createdByUserId),
  ],
)

// ─── User consent grants ─────────────────────────────────────────────────
//
// One row per user × client × scope-set. Created on consent screen submit;
// referenced by all tokens issued under that grant so a single revocation
// (admin revokes the grant) cascades to refresh tokens.

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: text('id').primaryKey(),
    payload: jsonb('payload').notNull(),
    accountId: text('account_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    clientId: text('client_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('oauth_grants_account_idx').on(t.accountId),
    index('oauth_grants_client_idx').on(t.clientId),
    index('oauth_grants_expires_idx').on(t.expiresAt),
  ],
)

// ─── Refresh tokens (with rotation + reuse detection) ────────────────────
//
// Opaque token IDs (cuid2-ish), full payload as JSONB, plus indexed
// columns for the load-bearing security operations:
//
//   account_id  → revoke all of a user's tokens on logout
//   client_id   → revoke all of a client's tokens on uninstall
//   grant_id    → reuse-detection cascades over a grant's token chain
//   expires_at  → cleanup job + active-session queries
//   revoked_at  → distinguishes rotated (within grace) from hard-revoked
//
// rotated_to_id chains the rotation graph — when a refresh token is used,
// its row records the id of the token it was rotated to. Reuse detection:
// if an already-rotated token is presented BEYOND the 60s grace window
// (per plan decision-log #9 + spec), the entire chain is revoked.

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    payload: jsonb('payload').notNull(),
    accountId: text('account_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    clientId: text('client_id'),
    grantId: text('grant_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    rotatedToId: text('rotated_to_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('oauth_refresh_tokens_account_idx').on(t.accountId),
    index('oauth_refresh_tokens_client_idx').on(t.clientId),
    index('oauth_refresh_tokens_grant_idx').on(t.grantId),
    index('oauth_refresh_tokens_expires_idx').on(t.expiresAt),
    index('oauth_refresh_tokens_revoked_idx').on(t.revokedAt),
  ],
)

// ─── Catch-all for transient oidc-provider models ────────────────────────
//
// node-oidc-provider tracks ~10 model types (Session, Interaction,
// AuthorizationCode, AccessToken, DeviceCode, ClientCredentials,
// RegistrationAccessToken, ReplayDetection, PushedAuthorizationRequest,
// BackchannelAuthenticationRequest). Most are short-lived (5-15 min) and
// not queried beyond by-id lookup, so they share one table keyed by
// (name, id). The cleanup job sweeps rows past expires_at.

export const oauthPayloads = pgTable(
  'oauth_payloads',
  {
    name: text('name').notNull(),
    id: text('id').notNull(),
    payload: jsonb('payload').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // findByUid lookup (Sessions are looked up by uid, not id)
    uid: text('uid'),
    // findByUserCode lookup (DeviceCode flow — unused in V1 but adapter
    // contract requires the column to be present for the index)
    userCode: text('user_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_payloads_name_id_idx').on(t.name, t.id),
    index('oauth_payloads_expires_idx').on(t.expiresAt),
    index('oauth_payloads_uid_idx').on(t.uid),
    index('oauth_payloads_user_code_idx').on(t.userCode),
  ],
)
