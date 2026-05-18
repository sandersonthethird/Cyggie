import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Multi-tenant root. One row per customer firm (VC firm in V1).
// Owns all CRM data via `firm_id` FKs and Postgres RLS predicates.
//
// FIRM LIFECYCLE:
//   [non-existent] ──Flow A: POST /auth/firms/claim──▶ [active, trial]
//   [active, trial] ──admin manually upgrades───────▶ [active, paid]
//                   ──trial_ends_at < now()─────────▶ [active, expired]
//                   ──admin closes account──────────▶ [archived]
//
// Cyggie infrastructure (Sentry, Fly, Neon, R2, Google OAuth client) stays
// single-instance across all firms — firm_id provides logical isolation only.
export const firms = pgTable(
  'firms',
  {
    id: text('id').primaryKey(), // cuid2
    name: varchar('name', { length: 200 }).notNull(),
    // URL slug for any future per-firm subdomain or path routing
    // (e.g. redswan.cyggie.app or cyggie.app/f/redswan). V1 doesn't surface this
    // in UI but reserving it now keeps the schema stable.
    slug: varchar('slug', { length: 64 }).notNull(),
    // Primary email domain for Flow C domain auto-join (deferred to M6).
    // Lowercased and validated as a host on write.
    primaryEmailDomain: varchar('primary_email_domain', { length: 253 }),
    // When true and primary_email_domain matches the OAuth identity domain,
    // returning users with no firm_id are auto-added as members.
    // Off by default — admin opts in per firm.
    domainAutoJoin: boolean('domain_auto_join').notNull().default(false),
    // 'trial' | 'paid' | 'expired' | 'archived'. V1 ships everyone on 'trial'
    // with manual toggles in Neon. Stripe wiring lands in Phase 2.
    plan: varchar('plan', { length: 32 }).notNull().default('trial'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    // Lamport clock — bumped by writeWithSync helper on every owned-row update.
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('firms_slug_idx').on(t.slug),
    index('firms_domain_idx')
      .on(t.primaryEmailDomain)
      .where(sql`${t.primaryEmailDomain} IS NOT NULL`),
  ],
)

// Pending invitations. Admin generates a token, emails the magic link
// `cyggie://invite/<token>` to the invitee, invitee taps → OAuth → /auth/firms/join
// resolves the token + matches the OAuth email, creates user with firm_id.
//
// SECURITY:
//   - tokenHash stores sha256(raw_token). Raw token is returned exactly once at
//     creation time and never again (so accidental DB exposure can't replay invites).
//   - email is lowercased on write. /auth/firms/join must match the OAuth identity
//     email or the join is rejected (prevents invite forwarding to a different account).
//   - 7-day default expiry; admin can revoke earlier.
export const invites = pgTable(
  'invites',
  {
    id: text('id').primaryKey(), // cuid2
    firmId: text('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(), // lowercased
    tokenHash: text('token_hash').notNull(), // sha256(raw_token)
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: text('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Look up pending invites by hash on /auth/firms/join.
    uniqueIndex('invites_token_hash_idx').on(t.tokenHash),
    // List pending invites for a firm in admin UI.
    index('invites_firm_pending_idx')
      .on(t.firmId)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    // Anti-spam: only one pending invite per (firm, email) at a time.
    uniqueIndex('invites_firm_email_pending_idx')
      .on(t.firmId, t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
)
