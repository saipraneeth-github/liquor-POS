CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"syndicate_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp with time zone,
	"payment_ref" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_barcode_unique";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_sku_unique";--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "paid_until" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_products_tenant_barcode" ON "products" USING btree (coalesce("syndicate_id", '00000000-0000-0000-0000-000000000000'::uuid),"barcode");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_products_tenant_sku" ON "products" USING btree (coalesce("syndicate_id", '00000000-0000-0000-0000-000000000000'::uuid),"sku");--> statement-breakpoint
UPDATE "syndicates" SET "max_branches" = GREATEST(CASE "plan" WHEN 'PRO' THEN 25 WHEN 'STANDARD' THEN 3 ELSE 1 END, (SELECT count(*)::int FROM "branches" b WHERE b."syndicate_id" = "syndicates"."id"));--> statement-breakpoint
UPDATE "syndicates" SET "paid_until" = now() + interval '365 days' WHERE "plan" <> 'TRIAL' AND "paid_until" IS NULL;--> statement-breakpoint
UPDATE "syndicates" SET "trial_ends_at" = now() + interval '14 days' WHERE "plan" = 'TRIAL' AND "trial_ends_at" IS NULL;--> statement-breakpoint
UPDATE "products" SET "syndicate_id" = (SELECT "id" FROM "syndicates" LIMIT 1) WHERE "syndicate_id" IS NULL AND (SELECT count(*) FROM "syndicates") = 1;
