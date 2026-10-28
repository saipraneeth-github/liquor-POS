CREATE TYPE "public"."tax_type" AS ENUM('GST', 'VAT_EXCISE');--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "tax_type" "tax_type" DEFAULT 'GST' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "tax_type" "tax_type" DEFAULT 'GST' NOT NULL;