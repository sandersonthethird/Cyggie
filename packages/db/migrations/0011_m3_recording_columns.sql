-- M3 — mobile recording happy path.
--
-- Adds:
--   • meetings.deepgram_request_id — set when the gateway submits audio to
--     Deepgram's batch API; used by the on-boot reconciler to recover stuck
--     jobs after a gateway restart.
--   • sessions.apns_device_token / apns_environment / apns_token_updated_at —
--     APNs push registration for "transcript ready" notifications.
--   • sessions_apns_token_idx — lookup-by-token for the 410 Unregistered
--     cleanup path on send failure.

ALTER TABLE "meetings" ADD COLUMN "deepgram_request_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "apns_device_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "apns_environment" varchar(16);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "apns_token_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sessions_apns_token_idx" ON "sessions" USING btree ("apns_device_token");
