-- OAuth deep-link recovery via deviceId polling.
--
-- ASWebAuthenticationSession on iOS sometimes returns dismiss/cancel after the
-- gateway has already minted a session row and issued tokens via the
-- cyggie://auth-callback redirect — the redirect never reaches the app. Mobile
-- now polls POST /auth/session/claim-by-device with its device_id; the gateway
-- finds the most-recent claimable session and re-mints fresh tokens.
--
-- recovered_at is a single-use flag: claim succeeds only while NULL. This caps
-- the blast radius if a device_id ever leaks — the recovery row can only be
-- claimed once, after which it requires a fresh OAuth round-trip.
--
-- sessions_device_created_idx is the hot path for the recovery lookup
-- (device_id = $1 AND created_at > now() - interval '120 seconds').

ALTER TABLE "sessions" ADD COLUMN "recovered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sessions_device_created_idx" ON "sessions" USING btree ("device_id","created_at");
