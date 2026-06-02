-- Slack thread continuity on chat_sessions (External Agents V1 slice 6).
--
-- All ALTER TABLE ADD COLUMN ops are non-blocking (constant-time
-- metadata update on Postgres 11+). Default 'app' on origin preserves
-- the semantics of every pre-slice-6 row.
--
-- The partial unique index uses COALESCE(thread_ts, '') so DMs (which
-- have NULL thread_ts because each DM message is its own thread by
-- Slack convention) get a deterministic unique key per (workspace,
-- channel) — without this NULL semantics would let us insert multiple
-- session rows for the same DM channel.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS origin varchar(16) NOT NULL DEFAULT 'app';

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS slack_workspace_id text;

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS slack_channel_id text;

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS slack_thread_ts text;

CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_slack_thread_idx
  ON chat_sessions (
    slack_workspace_id,
    slack_channel_id,
    COALESCE(slack_thread_ts, '')
  )
  WHERE origin = 'slack';

CREATE INDEX IF NOT EXISTS chat_sessions_origin_idx
  ON chat_sessions (origin);
