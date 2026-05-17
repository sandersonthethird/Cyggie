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
import { orgCompanies } from './companies'
import { pipelineStages } from './pipeline'

// Deals — investment-stage pipeline tracking per company. Source migration 029.
export const deals = pgTable(
  'deals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    pipelineName: text('pipeline_name'),
    stage: varchar('stage', { length: 64 }).notNull(),
    stageId: text('stage_id').references(() => pipelineStages.id, { onDelete: 'set null' }),
    stageUpdatedAt: timestamp('stage_updated_at', { withTimezone: true }).notNull().defaultNow(),
    ownerName: text('owner_name'),
    crmProvider: varchar('crm_provider', { length: 32 }),
    crmDealId: text('crm_deal_id'),
    amountTargetUsd: integer('amount_target_usd'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deals_user_idx').on(t.userId),
    index('deals_company_idx').on(t.companyId),
    index('deals_stage_idx').on(t.stage),
    index('deals_stage_id_idx').on(t.stageId),
    uniqueIndex('deals_company_crm_idx').on(t.companyId, t.crmDealId),
  ],
)
