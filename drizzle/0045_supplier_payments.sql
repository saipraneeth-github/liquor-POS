-- Payments made to suppliers (depots / distributors) against their invoices. Each posts Dr SUNDRY_CREDITORS / Cr CASH|BANK.
-- Never deleted: voided with a reason (and a reversing voucher), like a bill or an expense.
CREATE TABLE IF NOT EXISTS "supplier_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "branch_id" uuid NOT NULL,
  "supplier_name" text NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "payment_mode" text NOT NULL,
  "payment_date" date NOT NULL,
  "reference" text,
  "notes" text,
  "recorded_by_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by_id" uuid,
  "void_reason" text,
  CONSTRAINT "ck_supplier_payments_amount" CHECK (amount > 0),
  CONSTRAINT "ck_supplier_payments_mode" CHECK (payment_mode IN ('CASH','UPI','CARD','BANK'))
);
--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_voided_by_id_users_id_fk" FOREIGN KEY ("voided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_supplier_payments_branch_date" ON "supplier_payments" ("branch_id", "payment_date");
