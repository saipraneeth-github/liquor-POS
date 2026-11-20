-- A closing count typed on a DRAFT counter sheet is a physical count. Without this flag every later POS bill
-- recomputed the closing from the books and erased the count (and with it the unbilled-sales discrepancy).
ALTER TABLE "daily_counter_sheet_lines" ADD COLUMN IF NOT EXISTS "closing_manual" boolean DEFAULT false NOT NULL;
