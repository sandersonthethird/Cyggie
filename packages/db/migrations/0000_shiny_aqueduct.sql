CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_encrypted" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"device_label" varchar(200),
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"google_sub" varchar(64) NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(200),
	"avatar_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"monthly_deepgram_minutes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_progress" (
	"source_table" varchar(64) PRIMARY KEY NOT NULL,
	"target_table" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"rows_migrated" text DEFAULT '0' NOT NULL,
	"rows_expected" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"table_name" varchar(64) NOT NULL,
	"row_id" text NOT NULL,
	"op" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"lamport" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"device_id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"last_pushed_lamport" text DEFAULT '0' NOT NULL,
	"last_pulled_lamport" text DEFAULT '0' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"device_id" varchar(64),
	"event_type" varchar(64) NOT NULL,
	"actor" varchar(64),
	"target_kind" varchar(64),
	"target_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_user_provider_idx" ON "oauth_tokens" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "oauth_needs_reauth_idx" ON "oauth_tokens" USING btree ("needs_reauth") WHERE "oauth_tokens"."needs_reauth" = true;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_idx" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "outbox_user_device_idx" ON "outbox" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "outbox_table_row_idx" ON "outbox" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "outbox_created_idx" ON "outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_state_user_idx" ON "sync_state" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_event_idx" ON "audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_kind","target_id");