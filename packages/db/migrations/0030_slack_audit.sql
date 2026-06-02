-- Slack user mapping + MCP audit log (External Agents V1 slice 7).
--
-- See packages/db/src/schema/slack_audit.ts for the per-table rationale.
-- Both tables created additively with IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS slack_user_mappings (
  id text PRIMARY KEY,
  slack_workspace_id text NOT NULL,
  slack_user_id text NOT NULL,
  cyggie_user_id text REFERENCES users(id) ON DELETE SET NULL,
  slack_email text,
  resolved_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS slack_user_mappings_workspace_user_idx
  ON slack_user_mappings (slack_workspace_id, slack_user_id);

CREATE INDEX IF NOT EXISTS slack_user_mappings_cyggie_idx
  ON slack_user_mappings (cyggie_user_id);

CREATE TABLE IF NOT EXISTS mcp_audit (
  id text PRIMARY KEY,
  surface text NOT NULL,
  tool_name text NOT NULL,
  firm_id text REFERENCES firms(id) ON DELETE SET NULL,
  on_behalf_of_user_id text REFERENCES users(id) ON DELETE SET NULL,
  on_behalf_of_slack_id text,
  slack_message_ts text,
  input_summary text,
  output_size integer,
  duration_ms integer,
  ok boolean NOT NULL,
  error_code text,
  extras jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mcp_audit_created_at_idx
  ON mcp_audit (created_at);

CREATE INDEX IF NOT EXISTS mcp_audit_firm_created_idx
  ON mcp_audit (firm_id, created_at);

CREATE INDEX IF NOT EXISTS mcp_audit_user_created_idx
  ON mcp_audit (on_behalf_of_user_id, created_at);

CREATE INDEX IF NOT EXISTS mcp_audit_tool_idx
  ON mcp_audit (tool_name);
