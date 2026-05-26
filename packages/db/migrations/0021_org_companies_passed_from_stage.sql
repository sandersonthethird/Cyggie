-- Capture the pipeline stage a deal was in immediately before being moved to
-- Pass. Mirror of SQLite migration 105. The desktop SyncAgent (Phase 1.5a)
-- pushes org_companies writes here via the outbox; without this column the
-- sync push validator (drizzle-zod, auto-derived from the schema) would
-- silently drop the field.
--
-- NULL for legacy passed rows — PipelineStepper falls back to today's
-- all-gray rendering for those.

ALTER TABLE "org_companies"
  ADD COLUMN IF NOT EXISTS "passed_from_stage" varchar(64);
