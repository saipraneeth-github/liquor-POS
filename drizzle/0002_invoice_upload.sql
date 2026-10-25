CREATE TABLE IF NOT EXISTS "invoice_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" DROP CONSTRAINT "uq_supplier_invoice_branch_number";--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "line_number" integer;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "match_status" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "match_method" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "match_confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "extracted_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD COLUMN "flags" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "source" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "rejected_by_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "extraction_warnings" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "extraction_meta" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_attachments_sha256" ON "invoice_attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_attachments_invoice" ON "invoice_attachments" USING btree ("invoice_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_rejected_by_id_users_id_fk" FOREIGN KEY ("rejected_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_supplier_invoice_live_number" ON "supplier_invoices" USING btree ("branch_id","supplier_name","invoice_number") WHERE status <> 'REJECTED';