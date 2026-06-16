ALTER TABLE "org_companies" ADD COLUMN "firm_id" text;--> statement-breakpoint
ALTER TABLE "org_companies" ADD COLUMN "field_lamports" jsonb;--> statement-breakpoint
ALTER TABLE "org_companies" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_companies" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "org_companies" ADD CONSTRAINT "org_companies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_companies" ADD CONSTRAINT "org_companies_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_companies_firm_lamport_idx" ON "org_companies" USING btree ("firm_id",("lamport"::numeric));--> statement-breakpoint
CREATE INDEX "org_companies_recycle_idx" ON "org_companies" USING btree ("firm_id","deleted_at") WHERE "org_companies"."deleted_at" IS NOT NULL;--> statement-breakpoint
-- Backfill firm_id from each company owner's firm (one-shot; new rows are
-- stamped by the gateway on push).
UPDATE "org_companies" SET "firm_id" = u."firm_id" FROM "users" u WHERE "org_companies"."user_id" = u."id" AND "org_companies"."firm_id" IS NULL;
