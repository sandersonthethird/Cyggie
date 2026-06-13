CREATE TABLE "app_config" (
	"firm_id" varchar(64) NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_config_firm_id_key_pk" PRIMARY KEY("firm_id","key")
);
--> statement-breakpoint
ALTER TABLE "shared_meetings" ADD COLUMN "firm_id" varchar(64);--> statement-breakpoint
ALTER TABLE "shared_memos" ADD COLUMN "firm_id" varchar(64);--> statement-breakpoint
ALTER TABLE "shared_notes" ADD COLUMN "firm_id" varchar(64);
