ALTER TABLE "contacts" ADD COLUMN "firm_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "field_lamports" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "firm_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "field_lamports" jsonb;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_firm_lamport_idx" ON "contacts" USING btree ("firm_id",("lamport"::numeric));--> statement-breakpoint
CREATE INDEX "contacts_visibility_idx" ON "contacts" USING btree ("firm_id","is_private","user_id");--> statement-breakpoint
CREATE INDEX "contacts_recycle_idx" ON "contacts" USING btree ("firm_id","deleted_at") WHERE "contacts"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "meetings_firm_lamport_idx" ON "meetings" USING btree ("firm_id",("lamport"::numeric));--> statement-breakpoint
CREATE INDEX "meetings_visibility_idx" ON "meetings" USING btree ("firm_id","is_private","user_id");--> statement-breakpoint
CREATE INDEX "meetings_recycle_idx" ON "meetings" USING btree ("firm_id","deleted_at") WHERE "meetings"."deleted_at" IS NOT NULL;--> statement-breakpoint
-- Backfill firm_id from each row owner's firm (one-shot; gateway stamps new rows
-- on push). user_id is NOT NULL on both tables, so it's the reliable owner key.
UPDATE "contacts" SET "firm_id" = u."firm_id" FROM "users" u WHERE "contacts"."user_id" = u."id" AND "contacts"."firm_id" IS NULL;--> statement-breakpoint
UPDATE "meetings" SET "firm_id" = u."firm_id" FROM "users" u WHERE "meetings"."user_id" = u."id" AND "meetings"."firm_id" IS NULL;