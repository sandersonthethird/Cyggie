-- self_name on meetings — owner's calendar-side display name, persisted
-- at meeting-creation time from CalendarEvent.selfName (extracted in
-- src/main/calendar/google-calendar.ts:16-17 but previously discarded).
--
-- Why this exists: the meeting-summary enhance handler needs to render
-- the owner alongside calendar attendees ("Attendees: Sandy (meeting
-- owner), Chris"). Without this column it had to look up users.display_name
-- using the REQUESTING user's id — which assumes user.sub == meeting.userId,
-- a constraint enforced today only by the ownership filter on /enhance.
-- Storing self_name on the row makes the owner identity travel with the
-- meeting, so the moment firm-shared meetings ship (T24) we don't have
-- a latent bug where a colleague enhancing your meeting gets their own
-- name pasted in as the owner.
--
-- Online-safe: nullable ALTER, no row rewrite at column add. The UPDATE
-- below DOES rewrite every existing meeting row (single-firm beta — small
-- table); if we ever migrate this against a large table, gate the UPDATE
-- behind a batched script instead.
--
-- IF NOT EXISTS for safe re-runs (same pattern as 0017).

ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "self_name" TEXT;

-- Backfill from users.display_name → first_name+last_name → email.
-- Rows whose owner has none of these (or whose user_id is orphaned)
-- stay NULL — the enhance handler's null-selfName branch handles them
-- cleanly (calendar attendees rendered without an owner prefix).
UPDATE "meetings" m
SET "self_name" = COALESCE(
    NULLIF(u."display_name", ''),
    NULLIF(TRIM(COALESCE(u."first_name", '') || ' ' || COALESCE(u."last_name", '')), ''),
    NULLIF(u."email", '')
  )
FROM "users" u
WHERE m."user_id" = u."id"
  AND m."self_name" IS NULL;
