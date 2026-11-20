-- The drawer also takes in cash khata repayments and pays out cash expenses without a bill. Keep both on the closing
-- so "expected cash in drawer" can be explained line by line.
ALTER TABLE "daily_closings" ADD COLUMN IF NOT EXISTS "cash_repayments" numeric(12, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "daily_closings" ADD COLUMN IF NOT EXISTS "cash_expenses" numeric(12, 2) DEFAULT '0' NOT NULL;
