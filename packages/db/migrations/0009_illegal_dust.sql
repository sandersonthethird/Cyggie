CREATE TABLE "oauth_pending" (
	"state" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"device_label" varchar(200),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauth_pending_expires_idx" ON "oauth_pending" USING btree ("expires_at");