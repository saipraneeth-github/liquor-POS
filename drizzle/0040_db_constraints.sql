-- 0040: database-level guards that used to live only in application code.
-- Each CHECK is added NOT VALID first (guards every new write at once, brief lock) and then validated. If OLD rows already
-- break a rule the validation only WARNS and the constraint stays NOT VALID: new writes are still guarded and the migration
-- does not fail on production data. Find offenders with the query in the NOTICE and fix them, then run
--   ALTER TABLE <t> VALIDATE CONSTRAINT <name>;
--
-- NOT added on purpose: customers.current_credit >= 0. A bill void after a repayment legitimately leaves the customer in
-- credit (credit.engine.ts applyCreditReversal "may go negative").

CREATE OR REPLACE FUNCTION pg_temp.add_check(tbl text, cname text, expr text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname) THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', tbl, cname, expr);
  BEGIN
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', tbl, cname);
  EXCEPTION WHEN check_violation THEN
    RAISE WARNING 'Constraint % on % left NOT VALID: existing rows break it. Find them with: SELECT * FROM % WHERE NOT (%)', cname, tbl, tbl, expr;
  END;
END
$fn$;
--> statement-breakpoint
SELECT pg_temp.add_check('stock',               'ck_stock_qty_nonneg',          'quantity >= 0');
--> statement-breakpoint
SELECT pg_temp.add_check('stock_by_type',       'ck_stock_by_type_qty_nonneg',  'quantity >= 0');
--> statement-breakpoint
SELECT pg_temp.add_check('bills',               'ck_bills_total_nonneg',        'total >= 0 AND subtotal >= 0 AND tax_amount >= 0');
--> statement-breakpoint
SELECT pg_temp.add_check('bill_items',          'ck_bill_items_amounts_nonneg', 'unit_price >= 0 AND line_total >= 0 AND tax_amount >= 0');
--> statement-breakpoint
SELECT pg_temp.add_check('expenses',            'ck_expenses_amount_pos',       'amount > 0');
--> statement-breakpoint
SELECT pg_temp.add_check('credit_transactions', 'ck_credit_txn_amount_pos',     'amount > 0');
--> statement-breakpoint
-- A posted ledger line must never vanish because someone deleted its voucher: RESTRICT instead of CASCADE.
-- (The code paths that legitimately delete vouchers - draft invoice delete, inventory reset - delete the lines first.)
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_voucher_id_journal_vouchers_id_fk;
--> statement-breakpoint
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_voucher_id_journal_vouchers_id_fk
  FOREIGN KEY (voucher_id) REFERENCES journal_vouchers (id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_voucher_id_journal_vouchers_id_fk;
--> statement-breakpoint
-- branch_product_costs.last_invoice_id was a bare uuid: a deleted invoice left a dangling id. Clear them, then add the FK.
UPDATE branch_product_costs b SET last_invoice_id = NULL
  WHERE b.last_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = b.last_invoice_id);
--> statement-breakpoint
ALTER TABLE branch_product_costs ADD CONSTRAINT fk_branch_costs_last_invoice
  FOREIGN KEY (last_invoice_id) REFERENCES supplier_invoices (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE branch_product_costs VALIDATE CONSTRAINT fk_branch_costs_last_invoice;
--> statement-breakpoint
-- bill_counters had only a UNIQUE: give it a real primary key (the same columns, so ON CONFLICT (branch_id, year) keeps working).
ALTER TABLE bill_counters ADD PRIMARY KEY (branch_id, year);
--> statement-breakpoint
ALTER TABLE bill_counters DROP CONSTRAINT IF EXISTS uq_bill_counter_branch_year;
--> statement-breakpoint
-- login_attempts was replaced by login_throttle (0031) and nothing reads it.
DROP TABLE IF EXISTS login_attempts;
