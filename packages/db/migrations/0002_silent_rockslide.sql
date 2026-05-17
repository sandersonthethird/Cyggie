CREATE TABLE "contact_decision_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"decision_type" varchar(64) NOT NULL,
	"decision_date" timestamp with time zone NOT NULL,
	"decision_owner" text,
	"rationale_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_steps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_emails" (
	"contact_id" text NOT NULL,
	"email" text NOT NULL,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_emails_contact_id_email_pk" PRIMARY KEY("contact_id","email")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"normalized_name" text NOT NULL,
	"email" text,
	"phone" text,
	"primary_company_id" text,
	"title" text,
	"contact_type" varchar(32),
	"linkedin_url" text,
	"crm_contact_id" text,
	"crm_provider" varchar(32),
	"twitter_handle" text,
	"other_socials" jsonb,
	"city" text,
	"state" text,
	"timezone" text,
	"pronouns" text,
	"birthday" text,
	"university" text,
	"previous_companies" jsonb,
	"work_history" jsonb,
	"education_history" jsonb,
	"tags" jsonb,
	"relationship_strength" varchar(32),
	"last_met_event" text,
	"warm_intro_path" text,
	"investor_stage" varchar(64),
	"fund_size" double precision,
	"typical_check_size_min" double precision,
	"typical_check_size_max" double precision,
	"investment_stage_focus" jsonb,
	"investment_sector_focus" jsonb,
	"investment_sector_focus_notes" text,
	"proud_portfolio_companies" jsonb,
	"linkedin_headline" text,
	"linkedin_skills" jsonb,
	"linkedin_enriched_at" timestamp with time zone,
	"talent_pipeline" varchar(32),
	"key_takeaways" text,
	"field_sources" jsonb,
	"notes" text,
	"last_meeting_at" timestamp with time zone,
	"last_email_at" timestamp with time zone,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_talent_pipeline_check" CHECK ("contacts"."talent_pipeline" IS NULL OR "contacts"."talent_pipeline" IN ('identified', 'exploring', 'ideating', 'parked'))
);
--> statement-breakpoint
ALTER TABLE "contact_decision_logs" ADD CONSTRAINT "contact_decision_logs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_decision_logs" ADD CONSTRAINT "contact_decision_logs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_decision_logs" ADD CONSTRAINT "contact_decision_logs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_decision_logs_contact_idx" ON "contact_decision_logs" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_emails_email_idx" ON "contact_emails" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contact_emails_contact_idx" ON "contact_emails" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_emails_single_primary_idx" ON "contact_emails" USING btree ("contact_id") WHERE "contact_emails"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX "contacts_user_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_name_idx" ON "contacts" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "contacts_full_name_idx" ON "contacts" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "contacts_updated_at_idx" ON "contacts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "contacts_created_by_idx" ON "contacts" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "contacts_updated_by_idx" ON "contacts" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "contacts_primary_company_idx" ON "contacts" USING btree ("primary_company_id");--> statement-breakpoint
CREATE INDEX "contacts_last_meeting_idx" ON "contacts" USING btree ("last_meeting_at");--> statement-breakpoint
CREATE INDEX "contacts_last_email_idx" ON "contacts" USING btree ("last_email_at");--> statement-breakpoint
ALTER TABLE "meeting_speaker_contact_links" ADD CONSTRAINT "meeting_speaker_contact_links_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_speaker_contact_links" ADD CONSTRAINT "meeting_speaker_contact_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;