CREATE TABLE IF NOT EXISTS "branch_product_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"cost_price" numeric(14, 6) NOT NULL,
	"previous_cost_price" numeric(14, 6),
	"cost_per_case" numeric(12, 2),
	"last_invoice_id" uuid,
	"last_invoice_number" text,
	"last_invoice_date" timestamp with time zone,
	"cost_updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_product_costs" ADD CONSTRAINT "branch_product_costs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_product_costs" ADD CONSTRAINT "branch_product_costs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_branch_product_cost" ON "branch_product_costs" USING btree ("branch_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_branch_product_costs_product" ON "branch_product_costs" USING btree ("product_id");--> statement-breakpoint
-- Seed each branch's cost from the invoice that last set the business-wide figure (that invoice knows its branch)
INSERT INTO "branch_product_costs" ("branch_id","product_id","cost_price","previous_cost_price","cost_per_case","last_invoice_id","last_invoice_number","last_invoice_date","cost_updated_at")
SELECT si."branch_id", p."id", p."cost_price", p."previous_cost_price", p."cost_per_case", p."last_invoice_id", p."last_invoice_number", p."last_invoice_date", coalesce(p."cost_updated_at", now())
FROM "products" p JOIN "supplier_invoices" si ON si."id" = p."last_invoice_id"
WHERE p."cost_price" IS NOT NULL
ON CONFLICT DO NOTHING;
