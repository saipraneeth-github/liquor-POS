ALTER TYPE "public"."invoice_status" ADD VALUE 'REVERSED';--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE 'TYPE_TRANSFER';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_sale_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_type_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uq_branch_sale_type" UNIQUE("branch_id","sale_type_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sale_type_id" uuid NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_product_price_type" UNIQUE("product_id","sale_type_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"syndicate_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_by_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sale_type_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_stock_by_type" UNIQUE("branch_id","product_id","sale_type_id")
);
--> statement-breakpoint
ALTER TABLE "daily_counter_sheets" DROP CONSTRAINT "uq_counter_sheet_branch_date";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_supplier_invoice_live_number";--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "sale_type_id" uuid;--> statement-breakpoint
ALTER TABLE "brand_code_mappings" ADD COLUMN IF NOT EXISTS "volume_ml" integer;--> statement-breakpoint
ALTER TABLE "daily_counter_sheet_lines" ADD COLUMN "transfer_bottles" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_counter_sheets" ADD COLUMN "sale_type_id" uuid;--> statement-breakpoint
ALTER TABLE "price_audit" ADD COLUMN "sale_type_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_audit" ADD COLUMN "sale_type_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN IF NOT EXISTS "volume_ml" integer;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "reversed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_sale_types" ADD CONSTRAINT "branch_sale_types_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_sale_types" ADD CONSTRAINT "branch_sale_types_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_types" ADD CONSTRAINT "sale_types_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_by_type" ADD CONSTRAINT "stock_by_type_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_by_type" ADD CONSTRAINT "stock_by_type_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_by_type" ADD CONSTRAINT "stock_by_type_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sale_types_tenant_code" ON "sale_types" USING btree (coalesce("syndicate_id", '00000000-0000-0000-0000-000000000000'::uuid),"code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sale_types_tenant_default" ON "sale_types" USING btree (coalesce("syndicate_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_default;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheets" ADD CONSTRAINT "daily_counter_sheets_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_audit" ADD CONSTRAINT "price_audit_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_audit" ADD CONSTRAINT "stock_audit_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_reversed_by_id_users_id_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_brand_code_vol_branch" ON "brand_code_mappings" USING btree ("brand_code",coalesce("volume_ml", 0),coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_counter_sheet_branch_date_type" ON "daily_counter_sheets" USING btree ("branch_id","sheet_date",coalesce("sale_type_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_supplier_invoice_live_number" ON "supplier_invoices" USING btree ("branch_id","supplier_name","invoice_number") WHERE status <> 'REJECTED' AND reversed_at IS NULL;

--> statement-breakpoint
-- Seed the default sale types for every existing tenant (Walk-in = default, priced by products.mrp; Janata = extra price list)
INSERT INTO "sale_types" ("syndicate_id", "code", "name", "sort_order", "is_default")
SELECT s."id", 'WALK_IN', 'Walk-in', 0, true FROM "syndicates" s
WHERE NOT EXISTS (SELECT 1 FROM "sale_types" t WHERE t."syndicate_id" = s."id" AND t."code" = 'WALK_IN');--> statement-breakpoint
INSERT INTO "sale_types" ("syndicate_id", "code", "name", "sort_order", "is_default")
SELECT s."id", 'JANATA', 'Janata', 1, false FROM "syndicates" s
WHERE NOT EXISTS (SELECT 1 FROM "sale_types" t WHERE t."syndicate_id" = s."id" AND t."code" = 'JANATA');--> statement-breakpoint
INSERT INTO "sale_types" ("syndicate_id", "code", "name", "sort_order", "is_default")
SELECT NULL, 'WALK_IN', 'Walk-in', 0, true
WHERE NOT EXISTS (SELECT 1 FROM "sale_types" t WHERE t."syndicate_id" IS NULL AND t."code" = 'WALK_IN');--> statement-breakpoint
INSERT INTO "sale_types" ("syndicate_id", "code", "name", "sort_order", "is_default")
SELECT NULL, 'JANATA', 'Janata', 1, false
WHERE NOT EXISTS (SELECT 1 FROM "sale_types" t WHERE t."syndicate_id" IS NULL AND t."code" = 'JANATA');