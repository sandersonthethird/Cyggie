CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" varchar(200) NOT NULL,
	"description" text,
	"category" varchar(64) NOT NULL,
	"system_prompt" text NOT NULL,
	"user_prompt_template" text NOT NULL,
	"instructions" text,
	"output_format" varchar(32) DEFAULT 'markdown' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_company_links" (
	"meeting_id" text NOT NULL,
	"company_id" text NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"linked_by" varchar(32) DEFAULT 'auto' NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_company_links_meeting_id_company_id_pk" PRIMARY KEY("meeting_id","company_id"),
	CONSTRAINT "meeting_company_links_confidence_range" CHECK ("meeting_company_links"."confidence" >= 0 AND "meeting_company_links"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "meeting_speaker_contact_links" (
	"meeting_id" text NOT NULL,
	"speaker_index" integer NOT NULL,
	"contact_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_speaker_contact_links_meeting_id_speaker_index_pk" PRIMARY KEY("meeting_id","speaker_index")
);
--> statement-breakpoint
CREATE TABLE "meeting_speakers" (
	"meeting_id" text NOT NULL,
	"speaker_index" integer NOT NULL,
	"speaker_id" text,
	"label" text DEFAULT 'Speaker' NOT NULL,
	CONSTRAINT "meeting_speakers_meeting_id_speaker_index_pk" PRIMARY KEY("meeting_id","speaker_index")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"duration_seconds" integer,
	"calendar_event_id" text,
	"meeting_platform" varchar(32),
	"meeting_url" text,
	"transcript_path" text,
	"summary_path" text,
	"recording_path" text,
	"transcript_drive_id" text,
	"summary_drive_id" text,
	"template_id" text,
	"speaker_count" integer DEFAULT 0 NOT NULL,
	"speaker_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transcript_segments" jsonb,
	"notes" text,
	"attendees" jsonb,
	"attendee_emails" jsonb,
	"chat_messages" jsonb,
	"companies" jsonb,
	"dismissed_companies" jsonb,
	"status" varchar(32) DEFAULT 'recording' NOT NULL,
	"was_impromptu" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speakers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_summaries" (
	"transcript_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"summary" text NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_summaries_transcript_path_content_hash_pk" PRIMARY KEY("transcript_path","content_hash")
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_company_links" ADD CONSTRAINT "meeting_company_links_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_company_links" ADD CONSTRAINT "meeting_company_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_company_links" ADD CONSTRAINT "meeting_company_links_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_speakers" ADD CONSTRAINT "meeting_speakers_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_speakers" ADD CONSTRAINT "meeting_speakers_speaker_id_speakers_id_fk" FOREIGN KEY ("speaker_id") REFERENCES "public"."speakers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_company_links_company_idx" ON "meeting_company_links" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "meeting_company_links_created_by_idx" ON "meeting_company_links" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "meeting_company_links_updated_by_idx" ON "meeting_company_links" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "speaker_contact_links_contact_idx" ON "meeting_speaker_contact_links" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "meetings_user_idx" ON "meetings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meetings_date_idx" ON "meetings" USING btree ("date");--> statement-breakpoint
CREATE INDEX "meetings_status_idx" ON "meetings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meetings_created_by_idx" ON "meetings" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "meetings_updated_by_idx" ON "meetings" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_calendar_event_idx" ON "meetings" USING btree ("calendar_event_id") WHERE "meetings"."calendar_event_id" IS NOT NULL;