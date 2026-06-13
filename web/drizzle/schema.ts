import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core'

/**
 * Firm-scoped key/value config the desktop pushes up (e.g. the web-chat model).
 * Keyed by (firmId, key) so each firm controls its own value; chat routes resolve
 * the firm from the share row (shared_*.firm_id) and look up the value here,
 * falling back to WEB_CHAT_DEFAULT_MODEL when absent or firm_id is null.
 */
export const appConfig = pgTable(
  'app_config',
  {
    firmId: varchar('firm_id', { length: 64 }).notNull(),
    key: varchar('key', { length: 64 }).notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.firmId, table.key] })]
)

export const sharedMeetings = pgTable(
  'shared_meetings',
  {
    id: serial('id').primaryKey(),
    token: varchar('token', { length: 12 }).unique().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    date: timestamp('date', { withTimezone: true }).notNull(),
    durationSeconds: integer('duration_seconds'),
    speakerMap: jsonb('speaker_map').notNull().default({}),
    attendees: jsonb('attendees'),
    summary: text('summary'),
    transcript: text('transcript').notNull(),
    notes: text('notes'),
    apiKeyEnc: text('api_key_enc').notNull(),
    logoUrl: text('logo_url'),
    firmName: varchar('firm_name', { length: 200 }),
    brandColor: varchar('brand_color', { length: 20 }),
    companies: jsonb('companies').$type<Array<{ name: string; logoUrl: string | null }>>(),
    // Firm that created the share; resolves the per-firm web-chat model at chat time.
    // Nullable: pre-migration shares and users who haven't completed firm onboarding.
    firmId: varchar('firm_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    chatCount: integer('chat_count').notNull().default(0),
  },
  (table) => [
    index('idx_shared_meetings_token').on(table.token),
  ]
)

export const rateLimits = pgTable('rate_limits', {
  token: varchar('token', { length: 12 })
    .primaryKey()
    .references(() => sharedMeetings.token, { onDelete: 'cascade' }),
  chatCountDay: integer('chat_count_day').notNull().default(0),
  lastReset: date('last_reset').notNull().defaultNow(),
  totalQueries: integer('total_queries').notNull().default(0),
})

export const sharedMemos = pgTable(
  'shared_memos',
  {
    id: serial('id').primaryKey(),
    token: varchar('token', { length: 12 }).unique().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    companyName: varchar('company_name', { length: 500 }).notNull(),
    contentMarkdown: text('content_markdown').notNull(),
    logoUrl: text('logo_url'),
    firmName: varchar('firm_name', { length: 200 }),
    brandColor: varchar('brand_color', { length: 20 }),
    companyLogoUrl: varchar('company_logo_url', { length: 2000 }),
    apiKeyEnc: text('api_key_enc').notNull(),
    // See shared_meetings.firm_id.
    firmId: varchar('firm_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    chatCount: integer('chat_count').notNull().default(0),
  },
  (table) => [
    index('idx_shared_memos_token').on(table.token),
  ]
)

export const memoRateLimits = pgTable('memo_rate_limits', {
  token: varchar('token', { length: 12 })
    .primaryKey()
    .references(() => sharedMemos.token, { onDelete: 'cascade' }),
  chatCountDay: integer('chat_count_day').notNull().default(0),
  lastReset: date('last_reset').notNull().defaultNow(),
  totalQueries: integer('total_queries').notNull().default(0),
})

export const sharedNotes = pgTable(
  'shared_notes',
  {
    id: serial('id').primaryKey(),
    token: varchar('token', { length: 12 }).unique().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    contentMarkdown: text('content_markdown').notNull(),
    apiKeyEnc: text('api_key_enc'),
    logoUrl: text('logo_url'),
    firmName: varchar('firm_name', { length: 200 }),
    brandColor: varchar('brand_color', { length: 20 }),
    // See shared_meetings.firm_id.
    firmId: varchar('firm_id', { length: 64 }),
    chatCount: integer('chat_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [index('idx_shared_notes_token').on(table.token)]
)

export const noteRateLimits = pgTable('note_rate_limits', {
  token: varchar('token', { length: 12 })
    .primaryKey()
    .references(() => sharedNotes.token, { onDelete: 'cascade' }),
  chatCountDay: integer('chat_count_day').notNull().default(0),
  lastReset: date('last_reset').notNull().defaultNow(),
  totalQueries: integer('total_queries').notNull().default(0),
})
