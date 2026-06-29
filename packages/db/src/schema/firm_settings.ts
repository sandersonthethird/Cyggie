import { sql } from 'drizzle-orm'
import { pgPolicy, pgTable, primaryKey, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import { firms } from './firms'

// Firm-wide key/value config — Neon-only, gateway-mediated, NOT desktop-synced.
//
// First (and only V1) consumer: the two-tier storage feature. An admin's chosen
// SHARED files location is stored here under key 'storageConfig' as a JSON string
// holding a MOUNT-RELATIVE Drive spec (e.g. {"provider":"gdrive","relPath":"Shared
// drives/Cyggie/Meeting Notes"}) — never an absolute path, because a shared Google
// Drive folder resolves to a different absolute path on each user's machine.
//
//   admin   PUT /firm/storage-config ──▶ firm_settings[(firm_id,'storageConfig')]
//   member  GET /firm/storage-config ──▶ each client resolves relPath to its own
//                                         ~/Library/CloudStorage/GoogleDrive-<acct>/… mount
//
// Why firm-scoped (not user_preferences): the shared location is a property of the
// FIRM — set once by an admin, inherited by every member. By contrast the per-user
// PRIVATE root stays in the desktop-local `settings` table (per-install, unsynced).
export const firmSettings = pgTable(
  'firm_settings',
  {
    firmId: text('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    value: text('value').notNull(),
    // Audit breadcrumb: the gateway stamps this from the admin's JWT.sub on write
    // (plain text, no FK — it's a "who last set this" hint, not a relation).
    updatedByUserId: text('updated_by_user_id'),
    // Lamport clock for parity with other owned rows (bumped on write by the gateway).
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.firmId, t.key] }),
    // Defense in depth: the gateway already scopes every query by JWT firm_id, but
    // an RLS select policy keeps the cyggie_readonly role (execute_sql) firm-bounded.
    pgPolicy('firm_settings_firm_visibility', {
      as: 'permissive',
      for: 'select',
      to: 'public',
      using: sql`firm_id = current_setting('app.firm_id', true)`,
    }),
  ],
)
