ALTER TABLE "brand_code_mappings" ADD COLUMN IF NOT EXISTS "volume_ml" integer;
--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN IF NOT EXISTS "volume_ml" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_brand_code_vol_branch" ON "brand_code_mappings" USING btree ("brand_code", coalesce("volume_ml", 0), coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid));
