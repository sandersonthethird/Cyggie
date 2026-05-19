CREATE TABLE "contact_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text
);
--> statement-breakpoint
ALTER TABLE "org_company_aliases" ADD COLUMN "lamport" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_emails" ADD COLUMN "lamport" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_company_links" ADD COLUMN "lamport" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_speaker_contact_links" ADD COLUMN "lamport" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_speakers" ADD COLUMN "lamport" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "is_group_event" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "is_group_event_user_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_session_messages" ADD COLUMN "lamport" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_tombstones" ADD CONSTRAINT "contact_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_tombstones_email_idx" ON "contact_tombstones" USING btree ("email");