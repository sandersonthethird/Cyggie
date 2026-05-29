-- User-authored note pinned to the top of the company Key Takeaways card.
-- Survives AI regeneration and is fed to the LLM as known truth. Nullable
-- so existing rows need no backfill. IF NOT EXISTS for re-run safety.
-- Mirrors SQLite migration 110-company-key-takeaways-user-note.ts.

ALTER TABLE "org_companies" ADD COLUMN IF NOT EXISTS "key_takeaways_user_note" TEXT;
