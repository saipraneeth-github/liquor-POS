ALTER TABLE "master_products" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "master_products" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "master_revision" integer;--> statement-breakpoint
-- Items already mapped are in sync with revision 1
UPDATE "products" SET "master_revision" = 1 WHERE "master_product_id" IS NOT NULL;
