import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Templates — meeting summarization templates (system prompt + user prompt template).
// Consolidates: migration 001 (initial), migration 034 (instructions column).
//
// V1 keeps the same template shape as desktop; only port additions are:
//   - `user_id` for multi-tenancy (template owner / scope)
//   - `_lamport` for sync
export const templates = pgTable('templates', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 64 }).notNull(),
  systemPrompt: text('system_prompt').notNull(),
  userPromptTemplate: text('user_prompt_template').notNull(),
  // Free-form per-template instructions surfaced in the editor (migration 034).
  instructions: text('instructions'),
  outputFormat: varchar('output_format', { length: 32 }).notNull().default('markdown'),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  lamport: text('lamport').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
