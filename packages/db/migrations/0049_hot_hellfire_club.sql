-- T3 P2 — firm-scope org_companies: per-firm UNIQUE(firm_id, normalized_name) so two
-- firms can each own a same-normalized-name company (the global index made the
-- gateway's auto-create-and-link a cross-firm leak). firm_id becomes NOT NULL.
--
-- Re-run the 0038 backfill idempotently first, so SET NOT NULL can't trip on a row
-- whose firm_id was created after 0038 ran. Any row STILL null afterwards is an
-- orphan (its owner has no firm) — SET NOT NULL then fails LOUDLY by design;
-- resolve those rows before applying rather than silently coercing them.
UPDATE "org_companies" SET "firm_id" = u."firm_id" FROM "users" u WHERE "org_companies"."user_id" = u."id" AND "org_companies"."firm_id" IS NULL;--> statement-breakpoint
DROP INDEX "org_companies_normalized_name_idx";--> statement-breakpoint
ALTER TABLE "org_companies" ALTER COLUMN "firm_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_companies_normalized_name_idx" ON "org_companies" USING btree ("firm_id","normalized_name");