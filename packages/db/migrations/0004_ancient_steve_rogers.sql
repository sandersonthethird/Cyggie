CREATE TABLE "note_folders" (
	"path" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"content" text DEFAULT '' NOT NULL,
	"company_id" text,
	"contact_id" text,
	"source_meeting_id" text,
	"theme_id" text,
	"is_pinned" integer DEFAULT 0 NOT NULL,
	"folder_path" text,
	"import_source" text,
	"source_digest_id" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_source_meeting_id_meetings_id_fk" FOREIGN KEY ("source_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_user_idx" ON "notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notes_company_idx" ON "notes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "notes_contact_idx" ON "notes" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "notes_updated_idx" ON "notes" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "notes_folder_path_idx" ON "notes" USING btree ("folder_path");--> statement-breakpoint
CREATE INDEX "notes_import_source_idx" ON "notes" USING btree ("import_source");--> statement-breakpoint
CREATE INDEX "notes_source_meeting_idx" ON "notes" USING btree ("source_meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_company_source_meeting_idx" ON "notes" USING btree ("company_id","source_meeting_id") WHERE "notes"."company_id" IS NOT NULL AND "notes"."source_meeting_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_contact_source_meeting_idx" ON "notes" USING btree ("contact_id","source_meeting_id") WHERE "notes"."contact_id" IS NOT NULL AND "notes"."source_meeting_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_untagged_idx" ON "notes" USING btree ("updated_at") WHERE "notes"."company_id" IS NULL AND "notes"."contact_id" IS NULL;--> statement-breakpoint
CREATE INDEX "notes_company_source_digest_idx" ON "notes" USING btree ("company_id","source_digest_id") WHERE "notes"."source_digest_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_fts_idx" ON "notes" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || "content"));