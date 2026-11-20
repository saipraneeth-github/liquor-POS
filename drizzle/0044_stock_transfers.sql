-- Stock transfers between the outlets of one business, plus the stock reasons transfers and returns need.
-- (A new enum value cannot be USED in the migration that adds it; nothing below uses them.)
ALTER TYPE "public"."stock_reason" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';
--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE IF NOT EXISTS 'SALES_RETURN';
--> statement-breakpoint
ALTER TYPE "public"."stock_reason" ADD VALUE IF NOT EXISTS 'PURCHASE_RETURN';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_number" text NOT NULL,
  "from_branch_id" uuid NOT NULL,
  "to_branch_id" uuid NOT NULL,
  "status" text DEFAULT 'IN_TRANSIT' NOT NULL,
  "note" text,
  "created_by_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "received_by_id" uuid,
  "received_at" timestamp with time zone,
  "cancelled_by_id" uuid,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  CONSTRAINT "stock_transfers_transfer_number_unique" UNIQUE ("transfer_number"),
  CONSTRAINT "ck_stock_transfers_status" CHECK (status IN ('IN_TRANSIT','RECEIVED','CANCELLED')),
  CONSTRAINT "ck_stock_transfers_distinct" CHECK (from_branch_id <> to_branch_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "received_quantity" integer,
  CONSTRAINT "uq_transfer_item_product" UNIQUE ("transfer_id", "product_id"),
  CONSTRAINT "ck_transfer_items_qty" CHECK (quantity > 0),
  CONSTRAINT "ck_transfer_items_received" CHECK (received_quantity IS NULL OR (received_quantity >= 0 AND received_quantity <= quantity))
);
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_id_users_id_fk" FOREIGN KEY ("received_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stock_transfers_from" ON "stock_transfers" ("from_branch_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stock_transfers_to" ON "stock_transfers" ("to_branch_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stock_transfer_items_transfer" ON "stock_transfer_items" ("transfer_id");
