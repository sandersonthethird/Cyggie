-- T33 — widen the user_credentials provider whitelist to include
-- 'exa' and 'webshare'. Anthropic, OpenAI, and Deepgram were already
-- allowed by migration 0016. Memo is deliberately excluded: memo-writing
-- stays desktop-only for the foreseeable future, so the gateway has no
-- reason to hold a per-user memo key.
--
-- IF NOT EXISTS / safe-rerun: DROP CONSTRAINT IF EXISTS then ADD
-- CONSTRAINT. Both are metadata-only on Postgres 12+; non-blocking.

ALTER TABLE "user_credentials"
  DROP CONSTRAINT IF EXISTS "user_credentials_provider_check";

ALTER TABLE "user_credentials"
  ADD CONSTRAINT "user_credentials_provider_check"
    CHECK ("provider" IN ('anthropic', 'openai', 'deepgram', 'exa', 'webshare'));
