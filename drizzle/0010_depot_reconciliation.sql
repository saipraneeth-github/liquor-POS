ALTER TABLE "supplier_invoices" ADD COLUMN "challan_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "challan_number" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "previous_credit" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "sub_total" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "net_invoice_value" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "total_invoice_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "retailer_credit_balance" numeric(14, 2);
