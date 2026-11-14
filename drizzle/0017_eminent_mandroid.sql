CREATE TABLE IF NOT EXISTS "bank_transaction_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"direction" text NOT NULL,
	"ledger_id" uuid NOT NULL,
	"match_text" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transaction_types" ADD CONSTRAINT "bank_transaction_types_account_id_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transaction_types" ADD CONSTRAINT "bank_transaction_types_ledger_id_account_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."account_ledgers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transaction_types" ADD CONSTRAINT "bank_transaction_types_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bank_type_account_name" ON "bank_transaction_types" USING btree ("account_id","name_key");