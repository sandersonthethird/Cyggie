-- Phase 4 — contacts + meetings firm-shared + is_private opt-out + RLS.
--
-- ⚠ RLS CORRECTNESS PRECONDITIONS (verify before applying to prod):
--   1. The gateway's main role (GATEWAY_DATABASE_URL) MUST be the OWNER of
--      contacts/meetings (or hold BYPASSRLS). Table owners bypass RLS unless
--      FORCE ROW LEVEL SECURITY is set (it is NOT here), so normal sync/REST
--      reads stay unaffected. On Neon the role that ran these migrations owns
--      the tables and is the same role the gateway connects with — so this
--      holds. A non-owner gateway role would start getting RLS-filtered.
--   2. The read-only role `cyggie_readonly` (NEON_READONLY_URL, used only by
--      cyggie_execute_sql) MUST NOT have BYPASSRLS — see ROLE_GRANT_SCRIPT in
--      api-gateway/src/db/readonly-pool.ts. cyggie_execute_sql SET LOCALs
--      app.user_id/app.firm_id per query to drive the policy.
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
CREATE POLICY "contacts_readonly_visibility" ON "contacts" AS PERMISSIVE FOR SELECT TO public USING (user_id = current_setting('app.user_id', true) OR (firm_id = current_setting('app.firm_id', true) AND is_private = false));--> statement-breakpoint
CREATE POLICY "meetings_readonly_visibility" ON "meetings" AS PERMISSIVE FOR SELECT TO public USING (user_id = current_setting('app.user_id', true) OR (firm_id = current_setting('app.firm_id', true) AND is_private = false));--> statement-breakpoint
-- Backfill firm_id from the owner's users.firm_id (drizzle-kit emits DDL only).
-- Rows whose owner has no firm stay NULL = not firm-visible (own-only), which
-- is the correct safe default for the firm-scoped + owner-aware pull.
UPDATE "contacts" SET "firm_id" = u."firm_id" FROM "users" u WHERE "contacts"."user_id" = u."id" AND "contacts"."firm_id" IS NULL;--> statement-breakpoint
UPDATE "meetings" SET "firm_id" = u."firm_id" FROM "users" u WHERE "meetings"."user_id" = u."id" AND "meetings"."firm_id" IS NULL;