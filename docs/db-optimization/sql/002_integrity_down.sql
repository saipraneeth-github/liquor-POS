-- Phase 2 (DOWN) — removes the constraints added by 002_integrity_up.sql. No data is touched.
ALTER TABLE products             DROP CONSTRAINT IF EXISTS fk_products_last_invoice;
ALTER TABLE bank_statement_lines DROP CONSTRAINT IF EXISTS fk_bank_line_statement_account;
ALTER TABLE bank_statements      DROP CONSTRAINT IF EXISTS uq_bank_statement_id_account;
ALTER TABLE kot_items             DROP CONSTRAINT IF EXISTS ck_kot_items_qty_pos;
ALTER TABLE bill_items            DROP CONSTRAINT IF EXISTS ck_bill_items_qty_pos;
ALTER TABLE journal_lines         DROP CONSTRAINT IF EXISTS ck_journal_line_one_side;
ALTER TABLE print_jobs            DROP CONSTRAINT IF EXISTS ck_print_jobs_status;
ALTER TABLE subscription_invoices DROP CONSTRAINT IF EXISTS ck_sub_invoice_status;
ALTER TABLE ledger_transactions   DROP CONSTRAINT IF EXISTS ck_ledger_txn_direction;
ALTER TABLE bank_accounts         DROP CONSTRAINT IF EXISTS ck_bank_account_scope;
ALTER TABLE bank_statement_lines  DROP CONSTRAINT IF EXISTS ck_bank_line_status;
ALTER TABLE expenses              DROP CONSTRAINT IF EXISTS ck_expenses_payment_mode;
ALTER TABLE credit_transactions   DROP CONSTRAINT IF EXISTS ck_credit_txn_pay_mode;
ALTER TABLE bills                 DROP CONSTRAINT IF EXISTS ck_bills_payment_mode;

-- OPTIONAL data restore (not run automatically): put back the dangling pointers that 002_integrity_up.sql cleared.
-- UPDATE products p SET last_invoice_id = b.last_invoice_id FROM products_last_invoice_orphans_backup b WHERE b.product_id = p.id AND p.last_invoice_id IS NULL;
-- The backup table itself is never dropped by these scripts.
