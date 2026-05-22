import { sql } from 'drizzle-orm'
import { check, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './auth'

// T24 — per-user provider credentials. THIS IS DIFFERENT FROM `settings`.
//
// The `settings` schema (settings.ts) explicitly excludes API credentials per
// its inline security note. That note is correct for user-facing preferences
// (theme, language). Credentials are sensitive enough to live in their own
// table so the access control story is unambiguous: gateway code that touches
// `user_credentials` is "AI provider routing"; gateway code that touches
// `settings` is "user preferences." No accidental cross-contamination.
//
// Storage posture (V1):
//   • TLS in transit (Neon requires it).
//   • At-rest encryption via Neon's storage encryption.
//   • NO app-level encryption (no pgcrypto), no per-row key wrapping.
//     This is acceptable for single-firm beta. When multi-tenant onboarding
//     lands, add pgcrypto with a server-rotation key and a one-shot
//     re-encrypt migration.
//
// Sync posture: NOT in OWNED_TABLES — credentials don't flow through the
// Phase 1.5a outbox. Desktop POSTs directly to the gateway via the
// `POST /user-credentials/:provider` route, and the gateway is the only
// reader. Mobile never reads or writes this table.

export const userCredentials = pgTable(
  'user_credentials',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider] }),
    // Forward-compatible: add new providers via ALTER TABLE ... ADD CONSTRAINT.
    check(
      'user_credentials_provider_check',
      sql`${t.provider} IN ('anthropic', 'openai', 'deepgram')`,
    ),
  ],
)
