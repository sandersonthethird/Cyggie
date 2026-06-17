ALTER TABLE "tasks" ADD COLUMN "firm_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "field_lamports" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_firm_lamport_idx" ON "tasks" USING btree ("firm_id",("lamport"::numeric));--> statement-breakpoint
CREATE INDEX "tasks_recycle_idx" ON "tasks" USING btree ("firm_id","deleted_at") WHERE "tasks"."deleted_at" IS NOT NULL;--> statement-breakpoint
-- Backfill firm_id from each task owner's firm (one-shot; new rows are stamped
-- by the gateway on push). PG tasks.user_id is NOT NULL, so it's the reliable
-- owner key (mirrors org_companies). created_by_user_id may be null on old rows.
UPDATE "tasks" SET "firm_id" = u."firm_id" FROM "users" u WHERE "tasks"."user_id" = u."id" AND "tasks"."firm_id" IS NULL;