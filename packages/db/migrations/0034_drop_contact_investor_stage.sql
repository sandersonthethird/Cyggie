-- Hard-drop the legacy contacts.investor_stage column from Neon. Superseded by
-- investment_stage_focus (the "Target Investment Stage" multi-select) and empty,
-- so the drop is non-destructive. Mirrors SQLite migration 116.
--
-- Idempotent (DROP COLUMN IF EXISTS) so db:push convergence is safe and the
-- drizzle journal stays re-baselined at 0031 (see commit 46c6dc3). The column
-- is removed from packages/db/src/schema/contacts.ts in the same change set, so
-- drizzle-zod write-validators no longer accept it.
ALTER TABLE contacts DROP COLUMN IF EXISTS investor_stage;
