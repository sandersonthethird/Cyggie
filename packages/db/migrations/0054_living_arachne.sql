CREATE TABLE "firm_settings" (
	"firm_id" text NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" text NOT NULL,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_settings_firm_id_key_pk" PRIMARY KEY("firm_id","key")
);
--> statement-breakpoint
ALTER TABLE "firm_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firm_settings" ADD CONSTRAINT "firm_settings_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "firm_settings_firm_visibility" ON "firm_settings" AS PERMISSIVE FOR SELECT TO public USING (firm_id = current_setting('app.firm_id', true));