-- Per-chat Anthropic prompt-caching toggle.
--
-- When true, the gateway tags the context-block segment of the system prompt
-- with `cache_control: ephemeral` so multi-turn chats read from cache on
-- turn 2+ at ~0.1× input cost. When false, the cache marker is omitted —
-- useful for one-shot questions where the 1.25× cache-write premium
-- wouldn't pay back.
--
-- Default TRUE preserves current behavior for existing sessions (which all
-- previously cached unconditionally). Idempotent.

ALTER TABLE "chat_sessions"
  ADD COLUMN IF NOT EXISTS "cache_enabled" boolean NOT NULL DEFAULT true;
