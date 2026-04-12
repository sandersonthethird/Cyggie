CREATE TABLE "memo_rate_limits" (
	"token" varchar(12) PRIMARY KEY NOT NULL,
	"chat_count_day" integer DEFAULT 0 NOT NULL,
	"last_reset" date DEFAULT now() NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"token" varchar(12) PRIMARY KEY NOT NULL,
	"chat_count_day" integer DEFAULT 0 NOT NULL,
	"last_reset" date DEFAULT now() NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(12) NOT NULL,
	"title" varchar(500) NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"duration_seconds" integer,
	"speaker_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attendees" jsonb,
	"summary" text,
	"transcript" text NOT NULL,
	"notes" text,
	"api_key_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"chat_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shared_meetings_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "shared_memos" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(12) NOT NULL,
	"title" varchar(500) NOT NULL,
	"company_name" varchar(500) NOT NULL,
	"content_markdown" text NOT NULL,
	"logo_url" varchar(2000),
	"company_logo_url" varchar(2000),
	"api_key_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"chat_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shared_memos_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "shared_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(12) NOT NULL,
	"title" varchar(500) NOT NULL,
	"content_markdown" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "shared_notes_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "memo_rate_limits" ADD CONSTRAINT "memo_rate_limits_token_shared_memos_token_fk" FOREIGN KEY ("token") REFERENCES "public"."shared_memos"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_token_shared_meetings_token_fk" FOREIGN KEY ("token") REFERENCES "public"."shared_meetings"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_shared_meetings_token" ON "shared_meetings" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_shared_memos_token" ON "shared_memos" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_shared_notes_token" ON "shared_notes" USING btree ("token");