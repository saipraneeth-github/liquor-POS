CREATE TABLE IF NOT EXISTS "dunning_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"syndicate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"kind" text,
	"status" text DEFAULT 'LOGGED' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"syndicate_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"provider_payment_id" text,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"paid_at" timestamp with time zone,
	CONSTRAINT "payment_orders_provider_order_id_unique" UNIQUE("provider_order_id")
);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "print_via_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "agent_token_hash" text;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "agent_last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "target" text DEFAULT 'NETWORK' NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "payload" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dunning_log" ADD CONSTRAINT "dunning_log_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_syndicate_id_syndicates_id_fk" FOREIGN KEY ("syndicate_id") REFERENCES "public"."syndicates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_invoice_id_subscription_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."subscription_invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_dunning_once" ON "dunning_log" USING btree ("syndicate_id","kind","period_key");