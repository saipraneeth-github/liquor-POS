CREATE UNIQUE INDEX IF NOT EXISTS "uq_daily_closing_branch_date" ON "daily_closings" USING btree ("branch_id","closing_date");
