import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Stress test reports — outputs of the memo stress-test agent. Source migrations
// 092 (initial), 093 (drop FKs — agent_runs and memo_versions can be hard-deleted
// while reports persist for audit trail). 092 stored FKs but 093 removed them, so
// we don't add them here either.
export const stressTestReports = pgTable(
  'stress_test_reports',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // No FKs on these — migration 093 explicitly dropped them.
    memoId: text('memo_id').notNull(),
    runId: text('run_id').notNull(),
    priorMemoVersionId: text('prior_memo_version_id').notNull(),
    summary: text('summary').notNull(),
    concernsJson: jsonb('concerns_json').notNull(),
    evidenceJson: jsonb('evidence_json').notNull(),
    recommendation: varchar('recommendation', { length: 64 }).notNull().default('proceed_with_caveats'),
    costEstimateUsd: doublePrecision('cost_estimate_usd').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stress_test_reports_memo_idx').on(t.memoId, t.createdAt),
    index('stress_test_reports_run_idx').on(t.runId),
  ],
)
