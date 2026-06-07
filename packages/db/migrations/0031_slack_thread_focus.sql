-- slack_thread_focus — per-thread "current entity" for Slack follow-up
-- context reuse (External Agents V1 follow-up, Part 2).
--
-- See packages/db/src/schema/slack_audit.ts for the rationale. Server-only
-- (not part of the SQLite↔Neon sync). One row per chat session; cascade-
-- deletes with the session. Created additively with IF NOT EXISTS so
-- re-running is safe.

CREATE TABLE IF NOT EXISTS slack_thread_focus (
  session_id text PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
