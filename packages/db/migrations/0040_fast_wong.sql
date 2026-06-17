CREATE TABLE "tombstones" (
	"entity_type" varchar(32) NOT NULL,
	"entity_id" text NOT NULL,
	"firm_id" text NOT NULL,
	"purged_by_user_id" text,
	"lamport" text DEFAULT '0' NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tombstones_entity_type_entity_id_pk" PRIMARY KEY("entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "tombstones" ADD CONSTRAINT "tombstones_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tombstones" ADD CONSTRAINT "tombstones_purged_by_user_id_users_id_fk" FOREIGN KEY ("purged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tombstones_firm_lamport_idx" ON "tombstones" USING btree ("firm_id",("lamport"::numeric));