-- 1. Master products reference table
CREATE TABLE IF NOT EXISTS "master_products" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "state"          text NOT NULL DEFAULT 'TS',
  "category_name"  text NOT NULL,
  "name"           text NOT NULL,
  "brand"          text NOT NULL,
  "volume_ml"      integer NOT NULL,
  "pack_quantity"  integer NOT NULL,
  "excise_code"    text NOT NULL,
  "sku"            text NOT NULL,
  "reference_mrp"  numeric(12,2),
  "reference_cost" numeric(14,6),
  "is_active"      boolean NOT NULL DEFAULT true,
  "created_at"     timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
-- Unique: a state's brand code exists in one volume only once
ALTER TABLE "master_products"
  ADD CONSTRAINT "uq_master_state_brand_vol" UNIQUE ("state", "excise_code", "volume_ml");
--> statement-breakpoint
-- SKU must be globally unique
ALTER TABLE "master_products"
  ADD CONSTRAINT "master_products_sku_unique" UNIQUE ("sku");
--> statement-breakpoint
-- 2. Add master_product_id to the tenant products table
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "master_product_id" uuid REFERENCES "master_products"("id");
--> statement-breakpoint
-- 3. Change products.mrp default to '0.00' so it can be omitted at creation time.
ALTER TABLE "products" ALTER COLUMN "mrp" SET DEFAULT '0.00';
--> statement-breakpoint
-- 4. Index for quick lookup: "which master product does this tenant product link to?"
CREATE INDEX IF NOT EXISTS "idx_products_master_product_id"
  ON "products" ("master_product_id");
--> statement-breakpoint
-- 5. Index for master catalog search by state + excise code (invoice matching hot path)
CREATE INDEX IF NOT EXISTS "idx_master_products_state_excise"
  ON "master_products" ("state", "excise_code");
