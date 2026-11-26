ALTER TABLE "ledger_transactions" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_account_id_bank_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE "ledger_transactions" AS txn
SET "account_id" = line."account_id"
FROM "bank_statement_lines" AS line
WHERE txn."bank_line_id" = line."id" AND txn."account_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_ledger_txn_account" ON "ledger_transactions" ("account_id", "txn_date");
