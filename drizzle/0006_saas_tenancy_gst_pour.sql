CREATE TABLE IF NOT EXISTS "branch_menu_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"is_available" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pour_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid,
	"expected_ml" integer NOT NULL,
	"counted_ml" integer NOT NULL,
	"variance_ml" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "customer_gstin" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "round_off" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "round_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hsn_code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "syndicate_id" uuid;--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "plan" text DEFAULT 'TRIAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "syndicates" ADD COLUMN "max_branches" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_menu_availability" ADD CONSTRAINT "branch_menu_availability_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "branch_menu_availability" ADD CONSTRAINT "branch_menu_availability_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pour_counts" ADD CONSTRAINT "pour_counts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pour_counts" ADD CONSTRAINT "pour_counts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pour_counts" ADD CONSTRAINT "pour_counts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_branch_menu_availability" ON "branch_menu_availability" USING btree ("branch_id","product_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
