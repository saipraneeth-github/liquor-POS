ALTER TABLE "products" ALTER COLUMN "cost_price" SET DATA TYPE numeric(14, 6);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ALTER COLUMN "cost_price" SET DATA TYPE numeric(14, 6);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ALTER COLUMN "total_amount" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "previous_cost_price" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cost_per_case" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "last_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "last_invoice_number" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "last_invoice_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cost_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "cases_delivered" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "bottles_delivered" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "pack_quantity" integer DEFAULT 12;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "case_rate" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "unit_derived_total" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "rounding_adjustment" numeric(10, 4) DEFAULT '0.0000';--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "previous_cost_price" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "cost_difference" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "cost_increase_pct" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "lines_basic_total" numeric(14, 2) DEFAULT '0.00';--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "mrp_rounding_off" numeric(12, 2) DEFAULT '0.00';--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "rounding_adjustment" numeric(10, 4) DEFAULT '0.0000';--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "special_excise_cess" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "turnover_tax" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "tcs_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "total_cases" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "total_bottles" integer DEFAULT 0;
