CREATE TABLE "firms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"primary_email_domain" varchar(253),
	"domain_auto_join" boolean DEFAULT false NOT NULL,
	"plan" varchar(32) DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"firm_id" text NOT NULL,
	"email" varchar(320) NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "firm_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" varchar(32) DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by_user_id" text;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "firms_slug_idx" ON "firms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "firms_domain_idx" ON "firms" USING btree ("primary_email_domain") WHERE "firms"."primary_email_domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_firm_pending_idx" ON "invites" USING btree ("firm_id") WHERE "invites"."accepted_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_firm_email_pending_idx" ON "invites" USING btree ("firm_id","email") WHERE "invites"."accepted_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_firm_idx" ON "users" USING btree ("firm_id");