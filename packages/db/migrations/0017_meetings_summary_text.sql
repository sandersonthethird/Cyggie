-- Item 2 (mobile summary tab) — surface AI summary content in Neon so
-- mobile can read it via GET /meetings/:id.
--
-- Today the summarizer writes only to a local file (summary_path on
-- desktop) and optionally Google Drive (summary_drive_id). Neither path
-- is reachable from mobile — adding a `summary` column on meetings is
-- the cheapest way to surface the content over the existing sync rail
-- (Phase 1.5a desktop → outbox → Neon).
--
-- Online-safe: metadata-only ALTER, no row rewrite, no default that
-- forces a backfill. Sub-millisecond lock window. Nullable — existing
-- rows surface `null` until re-summarized (acceptable for single-firm
-- beta per plan §2a).
--
-- IF NOT EXISTS for safe re-runs against the single Neon branch (same
-- pattern as 0015 / 0016).

ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "summary" TEXT;
