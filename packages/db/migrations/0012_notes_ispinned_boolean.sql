-- notes.is_pinned was originally integer (0/1) but every other boolean-ish
-- column in the project (meetings.was_impromptu, meetings.is_group_event,
-- etc.) uses a real boolean. Desktop's notes.repo already converts
-- (`is_pinned === 1`) and emits a boolean in outbox payloads — drizzle-zod
-- on the gateway rejected those with "expected number, received boolean",
-- which stuck Phase 1.5a sync rows in the outbox.
--
-- Cast in place using the standard `USING (col <> 0)` pattern so existing
-- 0/1 values map to false/true. Default flips to `false`.

ALTER TABLE "notes"
  ALTER COLUMN "is_pinned" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "notes"
  ALTER COLUMN "is_pinned" TYPE boolean USING ("is_pinned" <> 0);--> statement-breakpoint
ALTER TABLE "notes"
  ALTER COLUMN "is_pinned" SET DEFAULT false;
