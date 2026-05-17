CREATE TABLE "themes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"thesis_statement" text,
	"status" varchar(32) DEFAULT 'exploring' NOT NULL,
	"conviction_score" integer,
	"owner_name" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"meeting_id" text,
	"company_id" text,
	"contact_id" text,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"category" varchar(32) DEFAULT 'action_item' NOT NULL,
	"priority" varchar(32),
	"assignee" text,
	"due_date" timestamp with time zone,
	"source" varchar(32) DEFAULT 'manual' NOT NULL,
	"source_section" text,
	"extraction_hash" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"attachments_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"context_id" text NOT NULL,
	"context_kind" varchar(32) NOT NULL,
	"context_label" text,
	"title" text,
	"preview_text" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"is_pinned" integer DEFAULT 0 NOT NULL,
	"is_archived" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_config_id" text NOT NULL,
	"label" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"sort_order" integer NOT NULL,
	"color" varchar(32),
	"is_terminal" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"field_key" varchar(64) NOT NULL,
	"label" text NOT NULL,
	"field_type" varchar(32) NOT NULL,
	"options_json" jsonb,
	"is_required" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"show_in_list" integer DEFAULT 0 NOT NULL,
	"is_builtin" integer DEFAULT 0 NOT NULL,
	"section" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cfd_entity_type_check" CHECK ("custom_field_definitions"."entity_type" IN ('company', 'contact')),
	CONSTRAINT "cfd_field_type_check" CHECK ("custom_field_definitions"."field_type" IN ('text', 'textarea', 'number', 'currency', 'date', 'url', 'select', 'multiselect', 'boolean', 'contact_ref', 'company_ref'))
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"field_definition_id" text NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"entity_id" text NOT NULL,
	"value_text" text,
	"value_number" double precision,
	"value_boolean" boolean,
	"value_date" timestamp with time zone,
	"value_ref_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cfv_entity_type_check" CHECK ("custom_field_values"."entity_type" IN ('company', 'contact'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"lamport" text DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"lamport" text DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "partner_meeting_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"week_of" timestamp with time zone NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"dismissed_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meeting_id" text,
	"archived_at" timestamp with time zone,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_meeting_items" (
	"id" text PRIMARY KEY NOT NULL,
	"digest_id" text NOT NULL,
	"company_id" text,
	"section" varchar(32) NOT NULL,
	"position" double precision NOT NULL,
	"title" text,
	"brief" text,
	"status_update" text,
	"meeting_notes" text,
	"is_discussed" integer DEFAULT 0 NOT NULL,
	"carry_over" integer DEFAULT 0 NOT NULL,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"pipeline_name" text,
	"stage" varchar(64) NOT NULL,
	"stage_id" text,
	"stage_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_name" text,
	"crm_provider" varchar(32),
	"crm_deal_id" text,
	"amount_target_usd" integer,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_memo_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"memo_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"content_markdown" text NOT NULL,
	"structured_json" jsonb,
	"change_note" text,
	"created_by" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_memos" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"theme_id" text,
	"deal_id" text,
	"title" text NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"latest_version_number" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memo_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"section" text,
	"claim_text" text NOT NULL,
	"claim_category" varchar(32),
	"source_type" varchar(32) NOT NULL,
	"source_id" text,
	"source_url" text,
	"snippet" text NOT NULL,
	"confidence" varchar(16) NOT NULL,
	"severity" varchar(16),
	"is_critique" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"payload_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(64) NOT NULL,
	"company_id" text NOT NULL,
	"mode" varchar(32),
	"status" varchar(32) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"iterations" integer DEFAULT 0 NOT NULL,
	"input_tokens_total" bigint DEFAULT 0 NOT NULL,
	"output_tokens_total" bigint DEFAULT 0 NOT NULL,
	"cache_read_input_tokens_total" bigint DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens_total" bigint DEFAULT 0 NOT NULL,
	"cost_estimate_usd" double precision DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"web_search_count" integer DEFAULT 0 NOT NULL,
	"error_class" varchar(64),
	"error_message" text,
	"result_version_id" text
);
--> statement-breakpoint
CREATE TABLE "stress_test_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"memo_id" text NOT NULL,
	"run_id" text NOT NULL,
	"prior_memo_version_id" text NOT NULL,
	"summary" text NOT NULL,
	"concerns_json" jsonb NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"recommendation" varchar(64) DEFAULT 'proceed_with_caveats' NOT NULL,
	"cost_estimate_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_session_messages" ADD CONSTRAINT "chat_session_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_config_id_pipeline_configs_id_fk" FOREIGN KEY ("pipeline_config_id") REFERENCES "public"."pipeline_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_definition_id_custom_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_meeting_digests" ADD CONSTRAINT "partner_meeting_digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_meeting_digests" ADD CONSTRAINT "partner_meeting_digests_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_meeting_items" ADD CONSTRAINT "partner_meeting_items_digest_id_partner_meeting_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."partner_meeting_digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_meeting_items" ADD CONSTRAINT "partner_meeting_items_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memo_versions" ADD CONSTRAINT "investment_memo_versions_memo_id_investment_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."investment_memos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memo_versions" ADD CONSTRAINT "investment_memo_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memo_versions" ADD CONSTRAINT "investment_memo_versions_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memo_evidence" ADD CONSTRAINT "memo_evidence_version_id_investment_memo_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."investment_memo_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stress_test_reports" ADD CONSTRAINT "stress_test_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "themes_user_name_idx" ON "themes" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "themes_user_slug_idx" ON "themes" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "themes_status_idx" ON "themes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_meeting_idx" ON "tasks" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "tasks_company_idx" ON "tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tasks_contact_idx" ON "tasks" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "tasks_extraction_hash_idx" ON "tasks" USING btree ("extraction_hash");--> statement-breakpoint
CREATE INDEX "chat_session_messages_session_idx" ON "chat_session_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_session_messages_fts_idx" ON "chat_session_messages" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "chat_sessions_user_idx" ON "chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_active_idx" ON "chat_sessions" USING btree ("context_id") WHERE "chat_sessions"."is_active" = 1;--> statement-breakpoint
CREATE INDEX "chat_sessions_recent_idx" ON "chat_sessions" USING btree ("is_archived","last_message_at" DESC);--> statement-breakpoint
CREATE INDEX "chat_sessions_context_idx" ON "chat_sessions" USING btree ("context_id","last_message_at" DESC);--> statement-breakpoint
CREATE INDEX "chat_sessions_pinned_idx" ON "chat_sessions" USING btree ("is_pinned","last_message_at" DESC) WHERE "chat_sessions"."is_archived" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_configs_default_idx" ON "pipeline_configs" USING btree ("user_id") WHERE "pipeline_configs"."is_default" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_config_slug_idx" ON "pipeline_stages" USING btree ("pipeline_config_id","slug");--> statement-breakpoint
CREATE INDEX "pipeline_stages_config_order_idx" ON "pipeline_stages" USING btree ("pipeline_config_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "cfd_entity_field_key_idx" ON "custom_field_definitions" USING btree ("entity_type","field_key");--> statement-breakpoint
CREATE INDEX "cfd_entity_type_idx" ON "custom_field_definitions" USING btree ("entity_type","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "cfv_definition_entity_idx" ON "custom_field_values" USING btree ("field_definition_id","entity_id");--> statement-breakpoint
CREATE INDEX "cfv_entity_idx" ON "custom_field_values" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_meeting_active_idx" ON "partner_meeting_digests" USING btree ("user_id") WHERE "partner_meeting_digests"."status" = 'active';--> statement-breakpoint
CREATE INDEX "partner_meeting_week_idx" ON "partner_meeting_digests" USING btree ("user_id","week_of");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_meeting_items_digest_company_idx" ON "partner_meeting_items" USING btree ("digest_id","company_id");--> statement-breakpoint
CREATE INDEX "partner_meeting_items_digest_section_idx" ON "partner_meeting_items" USING btree ("digest_id","section","position");--> statement-breakpoint
CREATE INDEX "deals_user_idx" ON "deals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deals_company_idx" ON "deals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deals_stage_idx" ON "deals" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "deals_stage_id_idx" ON "deals" USING btree ("stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_company_crm_idx" ON "deals" USING btree ("company_id","crm_deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_memo_versions_memo_version_idx" ON "investment_memo_versions" USING btree ("memo_id","version_number");--> statement-breakpoint
CREATE INDEX "investment_memo_versions_memo_idx" ON "investment_memo_versions" USING btree ("memo_id");--> statement-breakpoint
CREATE INDEX "investment_memos_user_idx" ON "investment_memos" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "investment_memos_company_idx" ON "investment_memos" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "investment_memos_status_idx" ON "investment_memos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memo_evidence_version_idx" ON "memo_evidence" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "memo_evidence_source_idx" ON "memo_evidence" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memo_evidence_internal_idx" ON "memo_evidence" USING btree ("version_id","section","claim_text","source_type","source_id") WHERE "memo_evidence"."source_type" != 'web';--> statement-breakpoint
CREATE UNIQUE INDEX "memo_evidence_web_idx" ON "memo_evidence" USING btree ("version_id","section","claim_text","source_url") WHERE "memo_evidence"."source_type" = 'web';--> statement-breakpoint
CREATE INDEX "agent_run_events_run_idx" ON "agent_run_events" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "agent_runs_user_idx" ON "agent_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_runs_company_idx" ON "agent_runs" USING btree ("company_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "agent_runs_running_idx" ON "agent_runs" USING btree ("started_at") WHERE "agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "stress_test_reports_memo_idx" ON "stress_test_reports" USING btree ("memo_id","created_at");--> statement-breakpoint
CREATE INDEX "stress_test_reports_run_idx" ON "stress_test_reports" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE set null ON UPDATE no action;