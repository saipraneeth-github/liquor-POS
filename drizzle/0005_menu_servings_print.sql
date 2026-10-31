CREATE TYPE "public"."menu_type" AS ENUM('RETAIL', 'KITCHEN', 'BAR');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_servings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"label" text NOT NULL,
	"volume_ml" integer,
	"price" numeric(12, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "serving_price_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serving_id" uuid NOT NULL,
	"user_id" uuid,
	"old_price" numeric(12, 2),
	"new_price" numeric(12, 2) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "serving_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "serving_label" text;--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "serving_ml" integer;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "printer_host" text;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "printer_port" integer DEFAULT 9100 NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "paper_width" text DEFAULT '58mm' NOT NULL;--> statement-breakpoint
ALTER TABLE "kot_items" ADD COLUMN "serving_id" uuid;--> statement-breakpoint
ALTER TABLE "kot_items" ADD COLUMN "serving_label" text;--> statement-breakpoint
ALTER TABLE "kot_items" ADD COLUMN "serving_ml" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "menu_type" "menu_type" DEFAULT 'RETAIL' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_available" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gst_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stock" ADD COLUMN "open_ml" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_audit" ADD COLUMN "change_ml" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_servings" ADD CONSTRAINT "product_servings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "serving_price_audit" ADD CONSTRAINT "serving_price_audit_serving_id_product_servings_id_fk" FOREIGN KEY ("serving_id") REFERENCES "public"."product_servings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "serving_price_audit" ADD CONSTRAINT "serving_price_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_serving_product_label" ON "product_servings" USING btree ("product_id","label");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_serving_id_product_servings_id_fk" FOREIGN KEY ("serving_id") REFERENCES "public"."product_servings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kot_items" ADD CONSTRAINT "kot_items_serving_id_product_servings_id_fk" FOREIGN KEY ("serving_id") REFERENCES "public"."product_servings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
