import { sql } from 'drizzle-orm'
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { orgCompanies } from './companies'
import { meetings } from './meetings'

// Partner Meeting Digest — Cyggie-native weekly document that replaces the partners'
// shared Google Doc for Tuesday partner meeting prep. Consolidates source migrations
// 059 (initial) and 061 (linked_meeting_id).
//
// Sections: 'priorities' | 'new_deals' | 'existing_deals' | 'portfolio' | 'passing' | 'admin'.
// Conclude-Meeting flow re-sections items based on current pipeline stage.
//
// This is an active major feature (see project_partner_meeting.md memory entry).

export const partnerMeetingDigests = pgTable(
  'partner_meeting_digests',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekOf: timestamp('week_of', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    dismissedSuggestions: jsonb('dismissed_suggestions').notNull().default([]),
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one active digest per user.
    uniqueIndex('partner_meeting_active_idx').on(t.userId).where(sql`${t.status} = 'active'`),
    index('partner_meeting_week_idx').on(t.userId, t.weekOf),
  ],
)

export const partnerMeetingItems = pgTable(
  'partner_meeting_items',
  {
    id: text('id').primaryKey(),
    digestId: text('digest_id')
      .notNull()
      .references(() => partnerMeetingDigests.id, { onDelete: 'cascade' }),
    companyId: text('company_id').references(() => orgCompanies.id, { onDelete: 'cascade' }),
    section: varchar('section', { length: 32 }).notNull(),
    position: doublePrecision('position').notNull(),
    title: text('title'),
    brief: text('brief'),
    statusUpdate: text('status_update'),
    meetingNotes: text('meeting_notes'),
    isDiscussed: integer('is_discussed').notNull().default(0),
    carryOver: integer('carry_over').notNull().default(0),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('partner_meeting_items_digest_company_idx').on(t.digestId, t.companyId),
    index('partner_meeting_items_digest_section_idx').on(t.digestId, t.section, t.position),
  ],
)
