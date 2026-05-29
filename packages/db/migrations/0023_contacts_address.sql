-- street / postal_code / country on contacts — fuller postal address
-- alongside the existing city/state columns. Nullable; safe ALTER (no
-- row rewrite on ADD COLUMN of a nullable text). IF NOT EXISTS for
-- re-run safety. Mirrors SQLite migration 108-contacts-address.ts.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "street" TEXT;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "country" TEXT;
