import { sql } from 'drizzle-orm'
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { orgCompanies } from './companies'

// Agent runs + events. Consolidates migrations 086 (initial), 087 (events),
// 091 (cache token columns), 094 (drop version_id FK — already handled by setting
// result_version_id as plain text without FK).
//
// V1 mobile: punt to V2 per plan ("Stress test / memo producer agent triggers from
// mobile — view results only"). Schema still ported so mobile can READ run status.

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    mode: varchar('mode', { length: 32 }),
    status: varchar('status', { length: 32 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    iterations: integer('iterations').notNull().default(0),
    inputTokensTotal: bigint('input_tokens_total', { mode: 'number' }).notNull().default(0),
    outputTokensTotal: bigint('output_tokens_total', { mode: 'number' }).notNull().default(0),
    cacheReadInputTokensTotal: bigint('cache_read_input_tokens_total', { mode: 'number' }).notNull().default(0),
    cacheCreationInputTokensTotal: bigint('cache_creation_input_tokens_total', { mode: 'number' }).notNull().default(0),
    costEstimateUsd: doublePrecision('cost_estimate_usd').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    webSearchCount: integer('web_search_count').notNull().default(0),
    errorClass: varchar('error_class', { length: 64 }),
    errorMessage: text('error_message'),
    // No FK on resultVersionId — migration 094 explicitly dropped it because version
    // rows can be hard-deleted while runs are retained for cost accounting.
    resultVersionId: text('result_version_id'),
  },
  (t) => [
    index('agent_runs_user_idx').on(t.userId),
    index('agent_runs_company_idx').on(t.companyId, sql`${t.startedAt} DESC`),
    index('agent_runs_running_idx').on(t.startedAt).where(sql`${t.status} = 'running'`),
  ],
)

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payloadJson: jsonb('payload_json').notNull(),
  },
  (t) => [index('agent_run_events_run_idx').on(t.runId, t.ts)],
)
