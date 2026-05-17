import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './auth'

// Settings + user preferences. Consolidates migration 001 (settings) and 043 (user_preferences).
//
// SECURITY note (per PR1 masked-keys work): API credentials (Deepgram, Anthropic, etc.)
// are NOT stored in this table on the gateway. Gateway secrets live in Fly env only.
// This table is for user-facing prefs (theme, language, calendar timezone, etc.)
//
// Both tables are user-scoped — gateway's user_id makes the SQLite-side "key" effectively
// a (user_id, key) compound primary key.

export const settings = pgTable(
  'settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    lamport: text('lamport').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
)

export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    lamport: text('lamport').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
)
