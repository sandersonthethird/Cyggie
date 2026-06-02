// Slack user mapping + MCP audit log (External Agents V1 slice 7).
//
// Two tables:
//   slack_user_mappings  — workspace + Slack user id → Cyggie user id.
//                          Populated lazily on first invocation per
//                          (workspace, slack_user) via Slack's
//                          users.info API, then cached forever.
//                          Mapping is best-effort enrichment (per
//                          plan Q7) — a Slack user without a
//                          matching Cyggie account still has a row
//                          here with cyggie_user_id = NULL.
//   mcp_audit            — one row per tool / cyggie_ask invocation
//                          across all external surfaces (Slack today,
//                          MCP route in a follow-up). Written via the
//                          async fire-and-forget buffer
//                          (api-gateway/src/audit/buffer.ts) per
//                          plan decision-log #27. Indexed for
//                          time-range admin queries.

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { firms } from './firms'

export const slackUserMappings = pgTable(
  'slack_user_mappings',
  {
    id: text('id').primaryKey(),
    slackWorkspaceId: text('slack_workspace_id').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    // null = Slack user has no matching Cyggie account. Stable state;
    // we don't re-attempt lookup on each call.
    cyggieUserId: text('cyggie_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Captured from Slack at lookup time. Useful for forensic queries
    // ("who mapped to this user?") and for re-running the lookup if
    // the user table changes.
    slackEmail: text('slack_email'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One row per Slack identity. Subsequent invocations from the same
    // user hit the cache.
    uniqueIndex('slack_user_mappings_workspace_user_idx').on(
      t.slackWorkspaceId,
      t.slackUserId,
    ),
    // Reverse lookup: which Slack users map to this Cyggie user?
    // Mainly for admin audits.
    index('slack_user_mappings_cyggie_idx').on(t.cyggieUserId),
  ],
)

export const mcpAudit = pgTable(
  'mcp_audit',
  {
    id: text('id').primaryKey(),
    // Caller context — every row identifies WHO invoked WHAT.
    // surface: 'slack' | 'mcp' (post-multi-firm split: maybe 'webhook')
    surface: text('surface').notNull(),
    // 'cyggie_ask' | 'cyggie_search' | etc. — see ASKS vs TOOLS below.
    toolName: text('tool_name').notNull(),
    // firmId is nullable for V1 single-firm beta (we don't enforce
    // per-firm scoping yet). Populated for forensic-lookup queries
    // once T3 firm_id propagation lands.
    firmId: text('firm_id').references(() => firms.id, { onDelete: 'set null' }),
    // Resolved Cyggie user. NULL when the Slack user has no
    // mapping (per plan Q7 — unmapped users still get audit rows).
    onBehalfOfUserId: text('on_behalf_of_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Raw Slack user id — always set when surface='slack'. Lets us
    // attribute forensically even when the mapping is missing.
    onBehalfOfSlackId: text('on_behalf_of_slack_id'),
    // The Slack message timestamp the call originated from (slash
    // commands provide it via the ack timestamp; events provide it
    // on event.ts). Forensic-lookup join key: "the bot answered
    // weirdly at 3pm yesterday" → look up by ts.
    slackMessageTs: text('slack_message_ts'),
    // Input/output telemetry. inputSummary truncated to 200 chars for
    // most tools; cyggie_execute_sql writes the full query untruncated
    // (slice 10 acceptance criterion).
    inputSummary: text('input_summary'),
    outputSize: integer('output_size'),
    durationMs: integer('duration_ms'),
    ok: boolean('ok').notNull(),
    errorCode: text('error_code'),
    // Free-form extras the surface wants to surface for analytics.
    extras: jsonb('extras'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Time-range queries are the load-bearing access pattern (admin
    // dashboards, "who used what last week").
    index('mcp_audit_created_at_idx').on(t.createdAt),
    // Per-firm time-range — supports a future per-firm admin view.
    index('mcp_audit_firm_created_idx').on(t.firmId, t.createdAt),
    // Per-user time-range — "what has Sandy been asking lately?".
    index('mcp_audit_user_created_idx').on(t.onBehalfOfUserId, t.createdAt),
    // Tool aggregation — "what's the error rate on cyggie_search?".
    index('mcp_audit_tool_idx').on(t.toolName),
  ],
)
