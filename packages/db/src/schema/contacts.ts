import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { orgCompanies } from './companies'

// =============================================================================
// CONTACTS — people we know. Consolidates source migrations:
//   022 (multi-email), 023 (name parts), 027 (contact_type), 036/038 (extra
//   fields v1/v2), 041 (legacy contact_notes — superseded by unified notes 052),
//   048 (field_sources), 051 (decision_logs), 066 (linkedin fields),
//   068 (talent_pipeline), 069 (key_takeaways), 025 (auth-foundation user FKs),
//   plus the pre-Phase-0.2 performance fix for full-table-scan touchpoint queries.
//
// Performance fix baked in (per plan-eng-review Section 7 — TODOS.md P2 "pre-compute
// contact activity touchpoints"): denormalized `last_meeting_at` + `last_email_at`
// columns. Updated by writeWithSync hooks on meeting / email writes so the hot path
// `listContacts(includeActivityTouchpoint=true)` becomes a simple column read instead
// of 3 full-table scans across meetings + email tables. Eliminates the worst RTT cost
// on mobile.
// =============================================================================

// talent_pipeline enum (migration 068). Defined as a CHECK constraint rather than a PG
// ENUM type — easier to extend (no migration for ALTER TYPE … ADD VALUE).
// 'internal_candidate' added 2026-05-17 for backfill compatibility with desktop data.
const TALENT_PIPELINE_STAGES = ['identified', 'exploring', 'ideating', 'parked', 'internal_candidate'] as const

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Identity / name
    fullName: text('full_name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    normalizedName: text('normalized_name').notNull(), // lower-case, accents stripped, for dedup
    // Primary email — kept denormalized in sync with contact_emails.is_primary=true via
    // the primary-email triggers (mirrored from SQLite).
    email: text('email'),
    phone: text('phone'),
    // Affiliation
    primaryCompanyId: text('primary_company_id').references(() => orgCompanies.id, { onDelete: 'set null' }),
    title: text('title'),
    contactType: varchar('contact_type', { length: 32 }), // 'founder' | 'investor' | 'operator' | etc.
    // External identities
    linkedinUrl: text('linkedin_url'),
    crmContactId: text('crm_contact_id'),
    crmProvider: varchar('crm_provider', { length: 32 }),
    twitterHandle: text('twitter_handle'),
    otherSocials: jsonb('other_socials'),
    // Geography
    street: text('street'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    timezone: text('timezone'),
    // Personal
    pronouns: text('pronouns'),
    birthday: text('birthday'), // mm-dd string (year often unknown)
    // History
    university: text('university'),
    previousCompanies: jsonb('previous_companies'),
    workHistory: jsonb('work_history'),
    educationHistory: jsonb('education_history'),
    // Tags
    tags: jsonb('tags'),
    // Relationship
    relationshipStrength: varchar('relationship_strength', { length: 32 }),
    lastMetEvent: text('last_met_event'),
    warmIntroPath: text('warm_intro_path'),
    // Investor-specific (migration 036, 038)
    fundSize: doublePrecision('fund_size'),
    typicalCheckSizeMin: doublePrecision('typical_check_size_min'),
    typicalCheckSizeMax: doublePrecision('typical_check_size_max'),
    investmentStageFocus: jsonb('investment_stage_focus'),
    investmentSectorFocus: jsonb('investment_sector_focus'),
    investmentSectorFocusNotes: text('investment_sector_focus_notes'),
    proudPortfolioCompanies: jsonb('proud_portfolio_companies'),
    // LinkedIn enrichment (migration 066)
    linkedinHeadline: text('linkedin_headline'),
    linkedinSkills: jsonb('linkedin_skills'),
    linkedinEnrichedAt: timestamp('linkedin_enriched_at', { withTimezone: true }),
    // Talent pipeline (migration 068)
    talentPipeline: varchar('talent_pipeline', { length: 32 }),
    // AI key takeaways (migration 069)
    keyTakeaways: text('key_takeaways'),
    // User-authored note pinned to the top of the Key Takeaways card (migration 108).
    // Survives AI regeneration; passed to the LLM as known truth.
    keyTakeawaysUserNote: text('key_takeaways_user_note'),
    // Source-of-truth tracking per field (migration 048). Map of fieldName → source.
    fieldSources: jsonb('field_sources'),
    // Free-form
    notes: text('notes'),
    // ----- Performance fix: denormalized activity touchpoints (Phase 0.2 baseline) -----
    // Maintained by writeWithSync hooks on meeting / email writes. Replaces 3 full-table
    // scans in contact.repo.ts:641-760 (existing TODOS.md P2 — see MIGRATION_AUDIT.md).
    lastMeetingAt: timestamp('last_meeting_at', { withTimezone: true }),
    lastEmailAt: timestamp('last_email_at', { withTimezone: true }),
    // Audit + sync
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contacts_user_idx').on(t.userId),
    uniqueIndex('contacts_email_idx').on(t.email),
    index('contacts_name_idx').on(t.normalizedName),
    index('contacts_full_name_idx').on(t.fullName),
    index('contacts_updated_at_idx').on(t.updatedAt),
    index('contacts_created_by_idx').on(t.createdByUserId),
    index('contacts_updated_by_idx').on(t.updatedByUserId),
    index('contacts_primary_company_idx').on(t.primaryCompanyId),
    // Indexes for the new touchpoint columns — these are the hot path for mobile.
    index('contacts_last_meeting_idx').on(t.lastMeetingAt),
    index('contacts_last_email_idx').on(t.lastEmailAt),
    // Talent pipeline enum constraint (migration 068). Mirrors TALENT_PIPELINE_STAGES.
    check(
      'contacts_talent_pipeline_check',
      sql`${t.talentPipeline} IS NULL OR ${t.talentPipeline} IN ('identified', 'exploring', 'ideating', 'parked', 'internal_candidate')`,
    ),
  ],
)

// Multi-email per contact (migration 022). Triggers maintain the invariant that at
// most one row per contact has is_primary=true, and contacts.email is kept in sync
// with whichever email is primary.
//
// SQLite implemented this with 3 triggers (INSERT, UPDATE, DELETE). Postgres mirrors
// the same behavior via plpgsql trigger functions — see migrations/<n>_contact_email_triggers.sql.
// For V1 the schema definition just enforces the partial UNIQUE constraint; the
// trigger logic lands in a manual migration alongside this generated one.
export const contactEmails = pgTable(
  'contact_emails',
  {
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    isPrimary: integer('is_primary').notNull().default(0), // 0 | 1 — SQLite-style for trigger compat
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.email] }),
    uniqueIndex('contact_emails_email_idx').on(t.email),
    index('contact_emails_contact_idx').on(t.contactId),
    // Partial UNIQUE: at most one primary email per contact.
    uniqueIndex('contact_emails_single_primary_idx')
      .on(t.contactId)
      .where(sql`${t.isPrimary} = 1`),
  ],
)

// Per-contact decision log (migration 051) — mirrors company_decision_logs structure.
// Captures decisions like "invited to firm dinner", "passed on as candidate", etc.
export const contactDecisionLogs = pgTable(
  'contact_decision_logs',
  {
    id: text('id').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    decisionType: varchar('decision_type', { length: 64 }).notNull(),
    decisionDate: timestamp('decision_date', { withTimezone: true }).notNull(),
    decisionOwner: text('decision_owner'),
    rationaleJson: jsonb('rationale_json').notNull().default([]),
    nextStepsJson: jsonb('next_steps_json').notNull().default([]),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contact_decision_logs_contact_idx').on(t.contactId)],
)

// Contact tombstones (migration 098). When a user-initiated CONTACT_DELETE runs, the
// IPC handler records each deleted email here so subsequent calendar/recording syncs
// don't resurrect the contact from the meeting attendee list. Cleared when the user
// explicitly recreates the contact (createContact / addContactEmail). Per-email, global
// scope — a deletion blocks recreation everywhere until manually undone.
export const contactTombstones = pgTable(
  'contact_tombstones',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(), // normalized: lower(trim())
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('contact_tombstones_email_idx').on(t.email)],
)
