ALTER TABLE "notes" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;