-- Customer returns (credit notes against a PAID bill) and returns to a supplier (debit notes). Neither is ever deleted.
CREATE TABLE IF NOT EXISTS "sales_returns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "return_number" text NOT NULL,
  "branch_id" uuid NOT NULL,
  "bill_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "refund_mode" text NOT NULL,
  "gross_amount" numeric(12, 2) NOT NULL,
  "tax_amount" numeric(12, 2) NOT NULL,
  "discount_amount" numeric(12, 2) NOT NULL,
  "refund_amount" numeric(12, 2) NOT NULL,
  "created_by_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_returns_return_number_unique" UNIQUE ("return_number"),
  CONSTRAINT "ck_sales_returns_mode" CHECK (refund_mode IN ('CASH','CARD','UPI','CREDIT')),
  CONSTRAINT "ck_sales_returns_amounts" CHECK (gross_amount >= 0 AND tax_amount >= 0 AND discount_amount >= 0 AND refund_amount >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_return_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "return_id" uuid NOT NULL,
  "bill_item_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "gross_amount" numeric(12, 2) NOT NULL,
  "tax_amount" numeric(12, 2) NOT NULL,
  CONSTRAINT "ck_sales_return_items_qty" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_returns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "return_number" text NOT NULL,
  "branch_id" uuid NOT NULL,
  "supplier_name" text NOT NULL,
  "invoice_id" uuid,
  "reason" text NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "created_by_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_returns_return_number_unique" UNIQUE ("return_number"),
  CONSTRAINT "ck_purchase_returns_amount" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_return_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "return_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "unit_cost" numeric(14, 6) NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  CONSTRAINT "ck_purchase_return_items_qty" CHECK (quantity > 0)
);
--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_bill_item_id_bill_items_id_fk" FOREIGN KEY ("bill_item_id") REFERENCES "public"."bill_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_return_id_purchase_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_returns_bill" ON "sales_returns" ("bill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_returns_branch_created" ON "sales_returns" ("branch_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_return_items_return" ON "sales_return_items" ("return_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sales_return_items_bill_item" ON "sales_return_items" ("bill_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_purchase_returns_branch_created" ON "purchase_returns" ("branch_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_purchase_return_items_return" ON "purchase_return_items" ("return_id");
