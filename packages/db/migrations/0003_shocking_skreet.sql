CREATE TABLE "company_decision_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"decision_type" varchar(64) NOT NULL,
	"decision_date" timestamp with time zone NOT NULL,
	"decision_owner" text,
	"amount_approved" text,
	"target_ownership" text,
	"more_if_possible" integer DEFAULT 0 NOT NULL,
	"structure" text,
	"rationale_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependencies_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_steps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_artifacts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_flagged_files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"file_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"flagged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_investors" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"investor_company_id" text NOT NULL,
	"investor_type" varchar(32) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"primary_domain" text,
	"website_url" text,
	"linkedin_company_url" text,
	"twitter_handle" text,
	"crunchbase_url" text,
	"angellist_url" text,
	"stage" varchar(64),
	"pipeline_stage" varchar(64),
	"priority" varchar(32),
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"entity_type" varchar(32) DEFAULT 'unknown' NOT NULL,
	"include_in_companies_view" integer DEFAULT 0 NOT NULL,
	"classification_source" varchar(32) DEFAULT 'auto' NOT NULL,
	"classification_confidence" double precision,
	"industry" text,
	"crm_provider" varchar(32),
	"crm_company_id" text,
	"city" text,
	"state" text,
	"hq_address" text,
	"founding_year" integer,
	"employee_count_range" varchar(32),
	"target_customer" text,
	"business_model" text,
	"product_stage" text,
	"revenue_model" text,
	"arr" double precision,
	"burn_rate" double precision,
	"runway_months" integer,
	"last_funding_date" timestamp with time zone,
	"total_funding_raised" double precision,
	"lead_investor" text,
	"lead_investor_company_id" text,
	"co_investors" jsonb,
	"round" varchar(64),
	"raise_size" double precision,
	"post_money_valuation" double precision,
	"relationship_owner" text,
	"deal_source" text,
	"warm_intro_source" text,
	"referral_contact_id" text,
	"next_followup_date" timestamp with time zone,
	"investment_size" text,
	"ownership_pct" text,
	"followon_investment_size" text,
	"total_invested" text,
	"investment_round" varchar(64),
	"initial_investment_security" text,
	"date_of_initial_investment" timestamp with time zone,
	"initial_round_size" double precision,
	"last_company_valuation" double precision,
	"followon_check" double precision,
	"followon_date" timestamp with time zone,
	"followon_check_2" double precision,
	"followon_date_2" timestamp with time zone,
	"investment_mark" double precision,
	"portfolio_fund" varchar(64),
	"source_type" varchar(32),
	"source_entity_type" varchar(32),
	"source_entity_id" text,
	"key_takeaways" text,
	"field_sources" jsonb,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_companies_classification_confidence_range" CHECK ("org_companies"."classification_confidence" IS NULL OR ("org_companies"."classification_confidence" >= 0 AND "org_companies"."classification_confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "org_company_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"alias_value" text NOT NULL,
	"alias_type" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_company_contacts" (
	"company_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"role_label" text,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_company_contacts_company_id_contact_id_pk" PRIMARY KEY("company_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "company_decision_logs" ADD CONSTRAINT "company_decision_logs_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_decision_logs" ADD CONSTRAINT "company_decision_logs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_decision_logs" ADD CONSTRAINT "company_decision_logs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_flagged_files" ADD CONSTRAINT "company_flagged_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_flagged_files" ADD CONSTRAINT "company_flagged_files_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_investors" ADD CONSTRAINT "company_investors_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_investors" ADD CONSTRAINT "company_investors_investor_company_id_org_companies_id_fk" FOREIGN KEY ("investor_company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_companies" ADD CONSTRAINT "org_companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_companies" ADD CONSTRAINT "org_companies_referral_contact_id_contacts_id_fk" FOREIGN KEY ("referral_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_companies" ADD CONSTRAINT "org_companies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_companies" ADD CONSTRAINT "org_companies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_company_aliases" ADD CONSTRAINT "org_company_aliases_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_company_contacts" ADD CONSTRAINT "org_company_contacts_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_company_contacts" ADD CONSTRAINT "org_company_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_decision_logs_company_idx" ON "company_decision_logs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_decision_logs_date_idx" ON "company_decision_logs" USING btree ("company_id","decision_date" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "company_flagged_files_company_file_idx" ON "company_flagged_files" USING btree ("company_id","file_id");--> statement-breakpoint
CREATE INDEX "company_investors_company_idx" ON "company_investors" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_investors_investor_idx" ON "company_investors" USING btree ("investor_company_id");--> statement-breakpoint
CREATE INDEX "company_investors_position_idx" ON "company_investors" USING btree ("company_id","investor_type","position");--> statement-breakpoint
CREATE INDEX "org_companies_user_idx" ON "org_companies" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_companies_normalized_name_idx" ON "org_companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "org_companies_domain_idx" ON "org_companies" USING btree ("primary_domain");--> statement-breakpoint
CREATE INDEX "org_companies_status_idx" ON "org_companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "org_companies_entity_type_idx" ON "org_companies" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "org_companies_include_view_idx" ON "org_companies" USING btree ("include_in_companies_view");--> statement-breakpoint
CREATE INDEX "org_companies_pipeline_idx" ON "org_companies" USING btree ("pipeline_stage");--> statement-breakpoint
CREATE INDEX "org_companies_priority_idx" ON "org_companies" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "org_companies_portfolio_fund_idx" ON "org_companies" USING btree ("portfolio_fund");--> statement-breakpoint
CREATE UNIQUE INDEX "org_company_aliases_company_type_value_idx" ON "org_company_aliases" USING btree ("company_id","alias_type","alias_value");--> statement-breakpoint
CREATE INDEX "org_company_aliases_value_idx" ON "org_company_aliases" USING btree ("alias_value");--> statement-breakpoint
CREATE INDEX "org_company_aliases_type_value_lower_idx" ON "org_company_aliases" USING btree ("alias_type",lower("alias_value"));--> statement-breakpoint
CREATE UNIQUE INDEX "org_company_contacts_single_primary_idx" ON "org_company_contacts" USING btree ("company_id") WHERE "org_company_contacts"."is_primary" = 1;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_primary_company_id_org_companies_id_fk" FOREIGN KEY ("primary_company_id") REFERENCES "public"."org_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_company_links" ADD CONSTRAINT "meeting_company_links_company_id_org_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."org_companies"("id") ON DELETE cascade ON UPDATE no action;