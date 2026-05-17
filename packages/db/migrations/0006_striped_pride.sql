ALTER TABLE "contacts" DROP CONSTRAINT "contacts_talent_pipeline_check";--> statement-breakpoint
DROP INDEX "notes_fts_idx";--> statement-breakpoint
CREATE INDEX "notes_fts_idx" ON "notes" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || substring("content" from 1 for 1048500)));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_talent_pipeline_check" CHECK ("contacts"."talent_pipeline" IS NULL OR "contacts"."talent_pipeline" IN ('identified', 'exploring', 'ideating', 'parked', 'internal_candidate'));