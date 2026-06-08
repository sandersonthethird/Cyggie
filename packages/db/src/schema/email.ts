// =============================================================================
// email.ts — lean Postgres projection of the desktop email tables, synced to
// Neon so the gateway chat context (mobile / web) can include tagged-email
// correspondence at parity with the desktop-local chat.
//
// DELIBERATELY LEAN (see plan "Part B — Gateway parity via lean email sync"):
//   • Only three tables are synced — `email_messages`, `email_company_links`,
//     `email_contact_links`. The desktop `email_threads`,
//     `email_message_participants`, `email_attachments`, and `email_accounts`
//     are NOT ported; the gateway derives thread aggregates (message count,
//     two-way detection) from the synced messages and retrieves via the link
//     tables only (a simplification of the desktop participant UNION).
//   • `body_text` is TRUNCATED at outbox-emit time (~4 KB; see
//     email-sync-backfill.service.ts) — raw 100 KB bodies never leave the
//     device, keeping Neon storage negligible.
//
// Column DB names mirror the SQLite columns 1:1 (snake_case) so the sync
// push handler's snake→camel normalization maps payloads cleanly. Integer
// flags (`is_unread`, `has_attachments`) stay `integer` to match the raw
// SQLite 0/1 values carried in the backfill payload (no boolean coercion).
// =============================================================================

import {
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { orgCompanies } from './companies'
import { contacts } from './contacts'

export const emailMessages = pgTable(
  'email_messages',
  {
    id: text('id').primaryKey(),
    // hasUserId: true in OWNED_TABLES → gateway stamps user_id from JWT.sub
    // before validation (SQLite email_messages has no user_id column).
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Plain text — the desktop `email_threads` table is not synced, so this is
    // a grouping key only (no FK). The gateway aggregates per thread_id.
    threadId: text('thread_id'),
    direction: varchar('direction', { length: 16 }).notNull(),
    subject: text('subject'),
    fromName: text('from_name'),
    fromEmail: text('from_email').notNull(),
    snippet: text('snippet'),
    // Truncated (~4 KB) at emit time — never the raw body.
    bodyText: text('body_text'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    labelsJson: text('labels_json'),
    isUnread: integer('is_unread').notNull().default(0),
    hasAttachments: integer('has_attachments').notNull().default(0),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_messages_user_idx').on(t.userId),
    index('email_messages_thread_idx').on(t.threadId),
  ],
)

export const emailCompanyLinks = pgTable(
  'email_company_links',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => emailMessages.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    confidence: doublePrecision('confidence').notNull().default(1.0),
    linkedBy: varchar('linked_by', { length: 32 }).notNull().default('auto'),
    reason: text('reason'),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.companyId] }),
    index('email_company_links_company_idx').on(t.companyId),
  ],
)

export const emailContactLinks = pgTable(
  'email_contact_links',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => emailMessages.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    confidence: doublePrecision('confidence').notNull().default(1.0),
    linkedBy: varchar('linked_by', { length: 32 }).notNull().default('auto'),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.contactId] }),
    index('email_contact_links_contact_idx').on(t.contactId),
  ],
)
