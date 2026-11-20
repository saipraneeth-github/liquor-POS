CREATE TABLE IF NOT EXISTS "branch_product_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sale_type_id" uuid,
	"price" numeric(12, 2) NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_product_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"master_product_id" uuid NOT NULL,
	"barcode" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "categories_name_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_brand_code_vol_branch";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_products_tenant_barcode";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_products_tenant_sku";--> statement-breakpoint
-- Every product must belong to a business. Refuse to guess an owner: if a NULL-tenant product exists, stop the migration
-- loudly so it can be assigned by hand (UPDATE products SET syndicate_id = '<id>' WHERE syndicate_id IS NULL) and re-run.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "products" WHERE "syndicate_id" IS NULL) THEN
  RAISE EXCEPTION 'Migration 0032: % product(s) have no syndicate_id. Assign them to a business first.', (SELECT count(*) FROM "products" WHERE "syndicate_id" IS NULL);
 END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "syndicate_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "state_code" text DEFAULT 'TS' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_code_mappings" ADD COLUMN "syndicate_id" uuid;--> statement-breakpoint
-- A mapping belongs to the business that owns its product
UPDATE "brand_code_mappings" m SET "syndicate_id" = p."syndicate_id" FROM "products" p WHERE p."id" = m."product_id";--> statement-breakpoint
ALTER TABLE "brand_code_mappings" ALTER COLUMN "syndicate_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "syndicate_id" uuid;--> statement-breakpoint
ALTER TABLE "price_audit" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_product_prices" ADD CONSTRAINT "branch_product_prices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_product_prices" ADD CONSTRAINT "branch_product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_product_prices" ADD CONSTRAINT "branch_product_prices_sale_type_id_sale_types_id_fk" FOREIGN KEY ("sale_type_id") REFERENCES "public"."sale_types"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_product_prices" ADD CONSTRAINT "branch_product_prices_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_product_barcodes" ADD CONSTRAINT "master_product_barcodes_master_product_id_master_products_id_fk" FOREIGN KEY ("master_product_id") REFERENCES "public"."master_products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_branch_product_price" ON "branch_product_prices" USING btree ("branch_id","product_id",coalesce("sale_type_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_branch_product_prices_product" ON "branch_product_prices" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_master_barcode" ON "master_product_barcodes" USING btree ("master_product_id","barcode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_master_barcode" ON "master_product_barcodes" USING btree ("barcode");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_code_mappings" ADD CONSTRAINT "brand_code_mappings_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_audit" ADD CONSTRAINT "price_audit_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_categories_owner_name" ON "categories" USING btree (coalesce("syndicate_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
-- Platform categories must exist for every category a master product names (tenants can no longer create them on the fly).
-- 18.00 is the rate the app used for auto-created categories; the Super Admin owns and can correct it.
INSERT INTO "categories" ("name", "tax_rate")
SELECT DISTINCT m."category_name", 18.00 FROM "master_products" m
WHERE NOT EXISTS (SELECT 1 FROM "categories" c WHERE c."syndicate_id" IS NULL AND lower(c."name") = lower(m."category_name"));--> statement-breakpoint
-- Map existing tenant products to the master where they obviously are the same bottle (same SKU, or same excise code + volume).
-- At most one product per tenant per master product; ambiguous leftovers stay as the tenant's own items.
WITH cand AS (
  SELECT DISTINCT ON (p."syndicate_id", m."id") p."id" AS pid, m."id" AS mid
  FROM "products" p
  JOIN "master_products" m ON m."is_active" AND (p."sku" = m."sku" OR (p."excise_code" = m."excise_code" AND p."volume_ml" = m."volume_ml"))
  WHERE p."master_product_id" IS NULL AND p."menu_type" = 'RETAIL'
    AND NOT EXISTS (SELECT 1 FROM "products" q WHERE q."syndicate_id" = p."syndicate_id" AND q."master_product_id" = m."id")
  ORDER BY p."syndicate_id", m."id", (p."sku" = m."sku") DESC, p."created_at"
), one AS (SELECT DISTINCT ON (pid) pid, mid FROM cand ORDER BY pid, mid)
UPDATE "products" SET "master_product_id" = one."mid" FROM one WHERE "products"."id" = one."pid";--> statement-breakpoint
-- Two products of one tenant pointing at the same master product: keep the oldest mapped, the rest become the tenant's own items
UPDATE "products" p SET "master_product_id" = NULL
WHERE p."master_product_id" IS NOT NULL AND p."id" <> (
  SELECT q."id" FROM "products" q WHERE q."syndicate_id" = p."syndicate_id" AND q."master_product_id" = p."master_product_id"
  ORDER BY q."created_at", q."id" LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_products_tenant_master" ON "products" USING btree ("syndicate_id","master_product_id") WHERE master_product_id is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_master_product_id" ON "products" USING btree ("master_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_brand_code_vol_branch" ON "brand_code_mappings" USING btree ("syndicate_id","brand_code",coalesce("volume_ml", 0),coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_products_tenant_barcode" ON "products" USING btree ("syndicate_id","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_products_tenant_sku" ON "products" USING btree ("syndicate_id","sku");--> statement-breakpoint
ALTER TABLE "master_products" DROP COLUMN IF EXISTS "reference_mrp";--> statement-breakpoint
ALTER TABLE "master_products" DROP COLUMN IF EXISTS "reference_cost";