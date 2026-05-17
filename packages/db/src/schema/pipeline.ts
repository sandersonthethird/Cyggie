import { sql } from 'drizzle-orm'
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

// Pipeline configs + stages. Consolidates migration 026 (pipeline_stages).
// V1 typically has one config ("default") with several stages (e.g. Sourcing →
// Diligence → IC → Term Sheet → Closed).

export const pipelineConfigs = pgTable(
  'pipeline_configs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: integer('is_default').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one default config per user.
    uniqueIndex('pipeline_configs_default_idx').on(t.userId).where(sql`${t.isDefault} = 1`),
  ],
)

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: text('id').primaryKey(),
    pipelineConfigId: text('pipeline_config_id')
      .notNull()
      .references(() => pipelineConfigs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    sortOrder: integer('sort_order').notNull(),
    color: varchar('color', { length: 32 }),
    isTerminal: integer('is_terminal').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pipeline_stages_config_slug_idx').on(t.pipelineConfigId, t.slug),
    index('pipeline_stages_config_order_idx').on(t.pipelineConfigId, t.sortOrder),
  ],
)
