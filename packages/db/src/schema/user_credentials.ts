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
// Storage posture (Slice C — multi-firm):
//   • TLS in transit (Neon requires it).
//   • At-rest encryption via Neon's storage encryption, PLUS app-level
//     AES-256-GCM envelope encryption of `value` (iv:authTag:ciphertext) keyed
//     by env.CREDENTIAL_ENC_KEY — a Fly secret, separate trust domain from Neon,
//     so a DB leak alone yields no usable provider keys. See auth/token-crypto.ts.
//   • The PUT route encrypts on write; llm/resolve-key.ts decrypts on read and
//     tolerates pre-encryption plaintext rows (Red Swan) transitionally until the
//     re-encrypt script (scripts/reencrypt-user-credentials.mjs) backfills them.
//     That tolerance is removed once zero plaintext rows remain (TODOS.md MF-2).
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
      sql`${t.provider} IN ('anthropic', 'openai', 'deepgram', 'exa', 'webshare')`,
    ),
  ],
)
