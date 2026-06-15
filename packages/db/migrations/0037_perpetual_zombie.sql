-- Postgres mirror of the private-notes feature (SQLite migration 121).
-- Adds notes.is_private + the visibility index that noteVisibilityFilter uses.
--
-- NOTE: drizzle-kit generate also emitted an `ALTER TABLE meetings ADD COLUMN
-- location` line here because the 0036 snapshot was behind (journal drift) —
-- that column is already owned by 0036_meetings_location.sql, so it was removed
-- to avoid a double-add. Statements are IF NOT EXISTS so this is safe to apply
-- against a DB where the column/index may already exist.

ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_visibility_idx" ON "notes" USING btree ("user_id","is_private","company_id","contact_id");
