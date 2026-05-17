DROP INDEX "notes_fts_idx";--> statement-breakpoint
CREATE INDEX "notes_fts_idx" ON "notes" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || substring("content" from 1 for 500000)));