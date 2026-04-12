CREATE TABLE "note_rate_limits" (
	"token" varchar(12) PRIMARY KEY NOT NULL,
	"chat_count_day" integer DEFAULT 0 NOT NULL,
	"last_reset" date DEFAULT now() NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_meetings" ADD COLUMN "logo_url" varchar(2000);--> statement-breakpoint
ALTER TABLE "shared_notes" ADD COLUMN "api_key_enc" text;--> statement-breakpoint
ALTER TABLE "shared_notes" ADD COLUMN "logo_url" varchar(2000);--> statement-breakpoint
ALTER TABLE "shared_notes" ADD COLUMN "chat_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "note_rate_limits" ADD CONSTRAINT "note_rate_limits_token_shared_notes_token_fk" FOREIGN KEY ("token") REFERENCES "public"."shared_notes"("token") ON DELETE cascade ON UPDATE no action;