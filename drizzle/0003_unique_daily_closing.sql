CREATE UNIQUE INDEX IF NOT EXISTS "uq_daily_closing_branch_date" ON "daily_closings" USING btree ("branch_id","closing_date");
-- Migration 0003: reserved for future schema changes.
-- Duplicate same-day closing protection is enforced at the application layer
-- in closing.service.ts (ConflictError 409) rather than a DB expression index
-- because closing_date is TIMESTAMPTZ and ::date depends on session timezone,
-- making it non-IMMUTABLE and incompatible with PGlite index expressions.
-- On a production Postgres instance with a stable timezone (e.g. UTC), you can
-- add this manually after confirming there are no existing duplicate rows:
--   CREATE UNIQUE INDEX daily_closings_branch_date_uniq
--     ON daily_closings (branch_id, (closing_date AT TIME ZONE 'UTC')::date);
SELECT 1;
