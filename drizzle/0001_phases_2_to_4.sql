CREATE TYPE "public"."counter_sheet_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."credit_txn_type" AS ENUM('PURCHASE', 'REPAYMENT', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."ledger_group" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."voucher_type" AS ENUM('SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'JOURNAL', 'CONTRA');--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE 'BREAKAGE';--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE 'COUNTER_SHEET';--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE 'SCHEME_FREE_GOODS';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"group" "ledger_group" NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"opening_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_ledger_branch_code" UNIQUE("branch_id","code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bill_counters" (
	"branch_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_bill_counter_branch_year" UNIQUE("branch_id","year")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "breakage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"cost_value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consolidated_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"syndicate_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"gross_sales" numeric(14, 2) NOT NULL,
	"total_tax" numeric(14, 2) NOT NULL,
	"bill_count" integer NOT NULL,
	"breakdown" jsonb NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" "credit_txn_type" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"balance_after" numeric(12, 2) NOT NULL,
	"bill_id" uuid,
	"payment_mode" text,
	"recorded_by_id" uuid NOT NULL,
	"client_ref" text,
	"notes" text,
	"recorded_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "credit_transactions_client_ref_unique" UNIQUE("client_ref")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"credit_allowed" boolean DEFAULT false NOT NULL,
	"credit_limit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"current_credit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_customer_branch_phone" UNIQUE("branch_id","phone")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_counter_sheet_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"opening_bottles" integer NOT NULL,
	"inward_bottles" integer DEFAULT 0 NOT NULL,
	"closing_bottles" integer NOT NULL,
	"sold_bottles" integer NOT NULL,
	"selling_rate" numeric(12, 2) NOT NULL,
	"line_revenue" numeric(14, 2) NOT NULL,
	"adjustment_approved_by_id" uuid,
	CONSTRAINT "uq_counter_sheet_line_product" UNIQUE("sheet_id","product_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_counter_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"sheet_date" date NOT NULL,
	"status" "counter_sheet_status" DEFAULT 'DRAFT' NOT NULL,
	"total_revenue" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"posted_by_id" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_counter_sheet_branch_date" UNIQUE("branch_id","sheet_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "excise_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"category_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"quota_cases" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"payment_mode" text NOT NULL,
	"expense_date" date NOT NULL,
	"notes" text,
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"debit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"voucher_number" text NOT NULL,
	"voucher_date" date NOT NULL,
	"voucher_type" "voucher_type" NOT NULL,
	"narration" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "journal_vouchers_voucher_number_unique" UNIQUE("voucher_number"),
	CONSTRAINT "uq_voucher_source" UNIQUE("source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheme_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheme_id" uuid NOT NULL,
	"min_cases" integer NOT NULL,
	"free_bottles" integer DEFAULT 0 NOT NULL,
	"discount_per_case" numeric(12, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "uq_scheme_slab_min_cases" UNIQUE("scheme_id","min_cases")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shift_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"status" "shift_status" DEFAULT 'OPEN' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now(),
	"closed_at" timestamp with time zone,
	"opening_float" numeric(12, 2) DEFAULT '0' NOT NULL,
	"expected_cash" numeric(12, 2),
	"counted_cash" numeric(12, 2),
	"cash_collected" numeric(12, 2) DEFAULT '0' NOT NULL,
	"upi_collected" numeric(12, 2) DEFAULT '0' NOT NULL,
	"card_collected" numeric(12, 2) DEFAULT '0' NOT NULL,
	"credit_collected" numeric(12, 2) DEFAULT '0' NOT NULL,
	"denominations" jsonb,
	"discrepancy" numeric(12, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"terminal_name" text NOT NULL,
	"device_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "terminals_device_key_unique" UNIQUE("device_key"),
	CONSTRAINT "uq_branch_terminal_name" UNIQUE("branch_id","terminal_name")
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "shift_session_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "client_ref" text;--> statement-breakpoint
ALTER TABLE "daily_closings" ADD COLUMN "credit_sales" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "syndicate_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_ledgers" ADD CONSTRAINT "account_ledgers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_counters" ADD CONSTRAINT "bill_counters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "breakage_logs" ADD CONSTRAINT "breakage_logs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "breakage_logs" ADD CONSTRAINT "breakage_logs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "breakage_logs" ADD CONSTRAINT "breakage_logs_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consolidated_invoices" ADD CONSTRAINT "consolidated_invoices_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consolidated_invoices" ADD CONSTRAINT "consolidated_invoices_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheet_lines" ADD CONSTRAINT "daily_counter_sheet_lines_sheet_id_daily_counter_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."daily_counter_sheets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheet_lines" ADD CONSTRAINT "daily_counter_sheet_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheet_lines" ADD CONSTRAINT "daily_counter_sheet_lines_adjustment_approved_by_id_users_id_fk" FOREIGN KEY ("adjustment_approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheets" ADD CONSTRAINT "daily_counter_sheets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheets" ADD CONSTRAINT "daily_counter_sheets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_counter_sheets" ADD CONSTRAINT "daily_counter_sheets_posted_by_id_users_id_fk" FOREIGN KEY ("posted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "excise_quotas" ADD CONSTRAINT "excise_quotas_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "excise_quotas" ADD CONSTRAINT "excise_quotas_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_voucher_id_journal_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."journal_vouchers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_ledger_id_account_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."account_ledgers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_vouchers" ADD CONSTRAINT "journal_vouchers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheme_slabs" ADD CONSTRAINT "scheme_slabs_scheme_id_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."schemes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shift_sessions" ADD CONSTRAINT "shift_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shift_sessions" ADD CONSTRAINT "shift_sessions_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shift_sessions" ADD CONSTRAINT "shift_sessions_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminals" ADD CONSTRAINT "terminals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_open_shift_cashier" ON "shift_sessions" USING btree ("cashier_id") WHERE status = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_open_shift_terminal" ON "shift_sessions" USING btree ("terminal_id") WHERE status = 'OPEN';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_shift_session_id_shift_sessions_id_fk" FOREIGN KEY ("shift_session_id") REFERENCES "public"."shift_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_client_ref_unique" UNIQUE("client_ref");--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "uq_supplier_invoice_branch_number" UNIQUE("branch_id","supplier_name","invoice_number");