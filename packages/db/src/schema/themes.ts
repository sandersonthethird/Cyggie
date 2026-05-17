import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Themes — firm investment thesis areas (e.g. "AI Infrastructure", "Climate Tech").
// Referenced by notes.theme_id and investment_memos.theme_id. Source migration 018.

export const themes = pgTable(
  'themes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    thesisStatement: text('thesis_statement'),
    status: varchar('status', { length: 32 }).notNull().default('exploring'),
    convictionScore: integer('conviction_score'),
    ownerName: text('owner_name'),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('themes_user_name_idx').on(t.userId, t.name),
    uniqueIndex('themes_user_slug_idx').on(t.userId, t.slug),
    index('themes_status_idx').on(t.status),
  ],
)
