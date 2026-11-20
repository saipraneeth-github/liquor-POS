CREATE TYPE "public"."flaw_link_type" AS ENUM('BLOCKS', 'BLOCKED_BY', 'RELATES_TO');--> statement-breakpoint
CREATE TYPE "public"."flaw_relation" AS ENUM('DUPLICATE_OF', 'SPLIT_FROM', 'MERGED_INTO');--> statement-breakpoint
CREATE TYPE "public"."flaw_severity" AS ENUM('BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL');--> statement-breakpoint
CREATE TYPE "public"."flaw_status" AS ENUM('NEW', 'TRIAGED', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'CLOSED', 'REOPENED', 'DUPLICATE', 'REJECTED', 'DEFERRED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flaw_id" uuid NOT NULL,
	"comment_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_flaw_attachment_sha" UNIQUE("flaw_id","sha256")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flaw_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_counters" (
	"tenant_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "flaw_counters_tenant_id_year_pk" PRIMARY KEY("tenant_id","year")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_duplicates" (
	"tenant_id" uuid NOT NULL,
	"canonical_id" uuid NOT NULL,
	"duplicate_id" uuid NOT NULL,
	"relation" "flaw_relation" DEFAULT 'DUPLICATE_OF' NOT NULL,
	"confidence" numeric(4, 3),
	"matched_by" text DEFAULT 'USER' NOT NULL,
	"similarity" numeric(4, 3),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flaw_duplicates_canonical_id_duplicate_id_pk" PRIMARY KEY("canonical_id","duplicate_id"),
	CONSTRAINT "uq_flaw_duplicates_once" UNIQUE("duplicate_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flaw_id" uuid NOT NULL,
	"changed_by_id" uuid,
	"action" text NOT NULL,
	"field_name" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"link_type" "flaw_link_type" DEFAULT 'RELATES_TO' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_flaw_link" UNIQUE("source_id","target_id","link_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_tag_map" (
	"flaw_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "flaw_tag_map_flaw_id_tag_id_pk" PRIMARY KEY("flaw_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	CONSTRAINT "uq_flaw_tags_tenant_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaw_watchers" (
	"flaw_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flaw_watchers_flaw_id_user_id_pk" PRIMARY KEY("flaw_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flaws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"title_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"description" text,
	"severity" "flaw_severity" DEFAULT 'MINOR' NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"status" "flaw_status" DEFAULT 'NEW' NOT NULL,
	"module_id" uuid,
	"environment" text,
	"affected_version" text,
	"fixed_version" text,
	"reporter_id" uuid NOT NULL,
	"assignee_id" uuid,
	"duplicate_of_id" uuid,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_flaws_tenant_reference" UNIQUE("tenant_id","reference"),
	CONSTRAINT "uq_flaws_fingerprint" UNIQUE("tenant_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_attempts" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quality_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_quality_modules_tenant_key" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_attachments" ADD CONSTRAINT "flaw_attachments_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_attachments" ADD CONSTRAINT "flaw_attachments_flaw_id_flaws_id_fk" FOREIGN KEY ("flaw_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_attachments" ADD CONSTRAINT "flaw_attachments_comment_id_flaw_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."flaw_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_attachments" ADD CONSTRAINT "flaw_attachments_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_comments" ADD CONSTRAINT "flaw_comments_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_comments" ADD CONSTRAINT "flaw_comments_flaw_id_flaws_id_fk" FOREIGN KEY ("flaw_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_comments" ADD CONSTRAINT "flaw_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_counters" ADD CONSTRAINT "flaw_counters_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_duplicates" ADD CONSTRAINT "flaw_duplicates_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_duplicates" ADD CONSTRAINT "flaw_duplicates_canonical_id_flaws_id_fk" FOREIGN KEY ("canonical_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_duplicates" ADD CONSTRAINT "flaw_duplicates_duplicate_id_flaws_id_fk" FOREIGN KEY ("duplicate_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_duplicates" ADD CONSTRAINT "flaw_duplicates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_history" ADD CONSTRAINT "flaw_history_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_history" ADD CONSTRAINT "flaw_history_flaw_id_flaws_id_fk" FOREIGN KEY ("flaw_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_history" ADD CONSTRAINT "flaw_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_links" ADD CONSTRAINT "flaw_links_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_links" ADD CONSTRAINT "flaw_links_source_id_flaws_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_links" ADD CONSTRAINT "flaw_links_target_id_flaws_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_links" ADD CONSTRAINT "flaw_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_tag_map" ADD CONSTRAINT "flaw_tag_map_flaw_id_flaws_id_fk" FOREIGN KEY ("flaw_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_tag_map" ADD CONSTRAINT "flaw_tag_map_tag_id_flaw_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."flaw_tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_tags" ADD CONSTRAINT "flaw_tags_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_watchers" ADD CONSTRAINT "flaw_watchers_flaw_id_flaws_id_fk" FOREIGN KEY ("flaw_id") REFERENCES "public"."flaws"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaw_watchers" ADD CONSTRAINT "flaw_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaws" ADD CONSTRAINT "flaws_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaws" ADD CONSTRAINT "flaws_module_id_quality_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."quality_modules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaws" ADD CONSTRAINT "flaws_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaws" ADD CONSTRAINT "flaws_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flaws" ADD CONSTRAINT "flaws_duplicate_of_id_flaws_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."flaws"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quality_modules" ADD CONSTRAINT "quality_modules_tenant_id_syndicates_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quality_modules" ADD CONSTRAINT "quality_modules_parent_id_quality_modules_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."quality_modules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quality_modules" ADD CONSTRAINT "quality_modules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_attachments_flaw" ON "flaw_attachments" USING btree ("flaw_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_comments_flaw" ON "flaw_comments" USING btree ("flaw_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_duplicates_canonical" ON "flaw_duplicates" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_history_flaw" ON "flaw_history" USING btree ("flaw_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_link_target" ON "flaw_links" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_tag_map_tag" ON "flaw_tag_map" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaw_watcher_user" ON "flaw_watchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_board" ON "flaws" USING btree ("tenant_id","status","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_assignee" ON "flaws" USING btree ("tenant_id","assignee_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_reporter" ON "flaws" USING btree ("tenant_id","reporter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_module" ON "flaws" USING btree ("tenant_id","module_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_created" ON "flaws" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_title_key" ON "flaws" USING btree ("tenant_id","title_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flaws_duplicate_of" ON "flaws" USING btree ("duplicate_of_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_modules_parent" ON "quality_modules" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bill_items_bill" ON "bill_items" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bills_branch_created" ON "bills" USING btree ("branch_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bills_branch_status" ON "bills" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_tx_customer" ON "credit_transactions" USING btree ("customer_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_journal_lines_voucher" ON "journal_lines" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_journal_lines_ledger" ON "journal_lines" USING btree ("ledger_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kot_items_order" ON "kot_items" USING btree ("kot_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stock_audit_branch_product" ON "stock_audit" USING btree ("branch_id","product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
