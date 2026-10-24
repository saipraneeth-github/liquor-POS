CREATE TYPE "public"."bill_status" AS ENUM('OPEN', 'PAID', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."closing_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."kot_destination" AS ENUM('KITCHEN', 'BAR');--> statement-breakpoint
CREATE TYPE "public"."kot_item_status" AS ENUM('PENDING', 'PREPARING', 'SERVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."kot_status" AS ENUM('PENDING', 'PREPARING', 'SERVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."scheme_status" AS ENUM('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."scheme_target_type" AS ENUM('QTY', 'VALUE');--> statement-breakpoint
CREATE TYPE "public"."stock_reason" AS ENUM('SALE', 'MANUAL_ADJUST', 'PURCHASE', 'VOID_REVERSAL', 'DAMAGE');--> statement-breakpoint
CREATE TYPE "public"."table_status" AS ENUM('FREE', 'OCCUPIED', 'RESERVED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'manager', 'cashier', 'steward');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bill_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"tax_amount" numeric(12, 2) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"bill_number" text NOT NULL,
	"status" "bill_status" DEFAULT 'OPEN' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"tax_amount" numeric(12, 2) NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"payment_mode" text,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "bills_bill_number_unique" UNIQUE("bill_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"syndicate_id" uuid,
	"parent_branch_id" uuid,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"gstin" text,
	"excise_license_no" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "branches_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	CONSTRAINT "categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"closed_by_id" uuid NOT NULL,
	"closing_date" timestamp with time zone DEFAULT now(),
	"opening_cash" numeric(12, 2) NOT NULL,
	"cash_sales" numeric(12, 2) NOT NULL,
	"card_sales" numeric(12, 2) NOT NULL,
	"upi_sales" numeric(12, 2) NOT NULL,
	"gross_sales" numeric(12, 2) NOT NULL,
	"total_tax" numeric(12, 2) NOT NULL,
	"cash_withdrawals" numeric(12, 2) DEFAULT '0' NOT NULL,
	"expected_cash_in_drawer" numeric(12, 2) NOT NULL,
	"actual_cash_counted" numeric(12, 2) NOT NULL,
	"cash_discrepancy" numeric(12, 2) NOT NULL,
	"is_balanced" boolean NOT NULL,
	"total_bills_count" integer NOT NULL,
	"paid_bills_count" integer NOT NULL,
	"voided_bills_count" integer NOT NULL,
	"notes" text,
	"status" "closing_status" DEFAULT 'CLOSED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kot_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"status" "kot_item_status" DEFAULT 'PENDING' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kot_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_session_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"destination" "kot_destination" DEFAULT 'KITCHEN' NOT NULL,
	"status" "kot_status" DEFAULT 'PENDING' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"old_mrp" numeric(12, 2),
	"new_mrp" numeric(12, 2) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid,
	"barcode" text,
	"sku" text,
	"name" text NOT NULL,
	"brand" text NOT NULL,
	"volume_ml" integer,
	"excise_code" text,
	"pack_quantity" integer,
	"mrp" numeric(12, 2) NOT NULL,
	"cost_price" numeric(12, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "products_barcode_unique" UNIQUE("barcode"),
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheme_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheme_id" uuid NOT NULL,
	"reference_id" uuid,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now(),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_name" text NOT NULL,
	"scheme_name" text NOT NULL,
	"target_type" "scheme_target_type" NOT NULL,
	"target_value" numeric(12, 2) NOT NULL,
	"current_value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reward_description" text NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"alert_threshold_pct" numeric(5, 2) DEFAULT '80.00' NOT NULL,
	"status" "scheme_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 5,
	CONSTRAINT "uq_branch_product" UNIQUE("branch_id","product_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid,
	"change_qty" integer NOT NULL,
	"reason" "stock_reason" NOT NULL,
	"reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"product_id" uuid,
	"raw_description" text NOT NULL,
	"quantity" integer NOT NULL,
	"cost_price" numeric(12, 2) NOT NULL,
	"mrp" numeric(12, 2) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '18.00' NOT NULL,
	"line_cost_total" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"approved_by_id" uuid,
	"supplier_name" text NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" timestamp with time zone,
	"total_amount" numeric(12, 2) NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syndicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"pan" text,
	"contact_phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"steward_id" uuid,
	"bill_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now(),
	"closed_at" timestamp with time zone,
	"guest_count" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer DEFAULT 4 NOT NULL,
	"status" "table_status" DEFAULT 'FREE' NOT NULL,
	"section" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_page_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"route_path" text NOT NULL,
	"can_access" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_user_route" UNIQUE("user_id","route_path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bills" ADD CONSTRAINT "bills_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branches" ADD CONSTRAINT "branches_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branches" ADD CONSTRAINT "branches_parent_branch_id_branches_id_fk" FOREIGN KEY ("parent_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_closings" ADD CONSTRAINT "daily_closings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_closings" ADD CONSTRAINT "daily_closings_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kot_items" ADD CONSTRAINT "kot_items_kot_order_id_kot_orders_id_fk" FOREIGN KEY ("kot_order_id") REFERENCES "public"."kot_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kot_items" ADD CONSTRAINT "kot_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kot_orders" ADD CONSTRAINT "kot_orders_table_session_id_table_sessions_id_fk" FOREIGN KEY ("table_session_id") REFERENCES "public"."table_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kot_orders" ADD CONSTRAINT "kot_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kot_orders" ADD CONSTRAINT "kot_orders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_audit" ADD CONSTRAINT "price_audit_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_audit" ADD CONSTRAINT "price_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheme_purchases" ADD CONSTRAINT "scheme_purchases_scheme_id_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."schemes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "schemes" ADD CONSTRAINT "schemes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_audit" ADD CONSTRAINT "stock_audit_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_audit" ADD CONSTRAINT "stock_audit_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_audit" ADD CONSTRAINT "stock_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice_items" ADD CONSTRAINT "supplier_invoice_items_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice_items" ADD CONSTRAINT "supplier_invoice_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_steward_id_users_id_fk" FOREIGN KEY ("steward_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tables" ADD CONSTRAINT "tables_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_page_permissions" ADD CONSTRAINT "user_page_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
