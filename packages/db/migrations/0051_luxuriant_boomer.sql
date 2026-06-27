ALTER TABLE "meetings" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "enrich_attempts" integer;--> statement-breakpoint
CREATE INDEX "meetings_enrich_pending_idx" ON "meetings" USING btree ("created_at") WHERE "meetings"."enriched_at" IS NULL;