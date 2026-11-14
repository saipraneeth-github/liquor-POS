-- ============================================================================
-- Phase 2 (UP) — integrity constraints. Adds rules only; changes no row.
-- Run 002_integrity_precheck.sql first (all zero rows).
-- Two-step pattern: ADD ... NOT VALID takes only a brief lock and starts guarding NEW writes immediately;
-- VALIDATE CONSTRAINT then scans the old rows while allowing normal reads and writes.
-- Rollback: 002_integrity_down.sql.
--
-- NOTE: stock.quantity >= 0 is deliberately NOT here. The app upserts stock with the DELTA as the proposed row
-- (counter.service.ts:648,656: INSERT ... VALUES (change) ON CONFLICT DO UPDATE SET quantity = quantity + EXCLUDED.quantity).
-- PostgreSQL checks a CHECK on that proposed row before conflict resolution, so a negative delta is rejected even when the
-- final value would be fine: 4 counter-sheet integration tests fail with the constraint on. See 002b_stock_nonneg_DEFERRED.sql.
-- ============================================================================

-- ── Step A: add (fast) ──────────────────────────────────────────────────────
ALTER TABLE bills                 ADD CONSTRAINT ck_bills_payment_mode      CHECK (payment_mode IS NULL OR payment_mode IN ('CASH','CARD','UPI','CREDIT')) NOT VALID;
ALTER TABLE credit_transactions   ADD CONSTRAINT ck_credit_txn_pay_mode    CHECK (payment_mode IS NULL OR payment_mode IN ('CASH','CARD','UPI')) NOT VALID;
ALTER TABLE expenses              ADD CONSTRAINT ck_expenses_payment_mode   CHECK (payment_mode IN ('CASH','CARD','UPI','BANK')) NOT VALID;
ALTER TABLE bank_statement_lines  ADD CONSTRAINT ck_bank_line_status        CHECK (status IN ('UNMATCHED','SUGGESTED','MATCHED','IGNORED')) NOT VALID;
ALTER TABLE bank_accounts         ADD CONSTRAINT ck_bank_account_scope      CHECK (scope IN ('BRANCH','SYNDICATE')) NOT VALID;
ALTER TABLE ledger_transactions   ADD CONSTRAINT ck_ledger_txn_direction    CHECK (direction IN ('DEBIT','CREDIT')) NOT VALID;
ALTER TABLE subscription_invoices ADD CONSTRAINT ck_sub_invoice_status      CHECK (status IN ('PENDING','PAID','VOID')) NOT VALID;
ALTER TABLE print_jobs            ADD CONSTRAINT ck_print_jobs_status       CHECK (status IN ('PENDING','SENT','FAILED') AND target IN ('NETWORK','AGENT')) NOT VALID;
ALTER TABLE journal_lines         ADD CONSTRAINT ck_journal_line_one_side   CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)) NOT VALID;
ALTER TABLE bill_items            ADD CONSTRAINT ck_bill_items_qty_pos      CHECK (quantity > 0) NOT VALID;
ALTER TABLE kot_items             ADD CONSTRAINT ck_kot_items_qty_pos       CHECK (quantity > 0) NOT VALID;

-- bank_statement_lines.account_id is a copy of statement -> account. Make the database prove the copy is right.
ALTER TABLE bank_statements ADD CONSTRAINT uq_bank_statement_id_account UNIQUE (id, account_id);
ALTER TABLE bank_statement_lines ADD CONSTRAINT fk_bank_line_statement_account
  FOREIGN KEY (statement_id, account_id) REFERENCES bank_statements (id, account_id) ON DELETE CASCADE NOT VALID;

-- Dangling pointers found on real data (invoices deleted while a product still cached their id). Back them up first, then clear
-- them: exactly what ON DELETE SET NULL would have done. last_invoice_number / last_invoice_date stay, so nothing readable is lost.
CREATE TABLE IF NOT EXISTS products_last_invoice_orphans_backup (
  product_id uuid PRIMARY KEY, last_invoice_id uuid, last_invoice_number text, last_invoice_date timestamptz, backed_up_at timestamptz DEFAULT now()
);
INSERT INTO products_last_invoice_orphans_backup (product_id, last_invoice_id, last_invoice_number, last_invoice_date)
  SELECT p.id, p.last_invoice_id, p.last_invoice_number, p.last_invoice_date FROM products p
  WHERE p.last_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = p.last_invoice_id)
  ON CONFLICT (product_id) DO NOTHING;
UPDATE products p SET last_invoice_id = NULL
  WHERE p.last_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = p.last_invoice_id);

-- products.last_invoice_id was a bare uuid with no FK: a dangling pointer is possible. SET NULL keeps the product.
ALTER TABLE products ADD CONSTRAINT fk_products_last_invoice
  FOREIGN KEY (last_invoice_id) REFERENCES supplier_invoices (id) ON DELETE SET NULL NOT VALID;

-- ── Step B: validate (scans old rows, does not block normal traffic) ───────
ALTER TABLE bills                 VALIDATE CONSTRAINT ck_bills_payment_mode;
ALTER TABLE credit_transactions   VALIDATE CONSTRAINT ck_credit_txn_pay_mode;
ALTER TABLE expenses              VALIDATE CONSTRAINT ck_expenses_payment_mode;
ALTER TABLE bank_statement_lines  VALIDATE CONSTRAINT ck_bank_line_status;
ALTER TABLE bank_accounts         VALIDATE CONSTRAINT ck_bank_account_scope;
ALTER TABLE ledger_transactions   VALIDATE CONSTRAINT ck_ledger_txn_direction;
ALTER TABLE subscription_invoices VALIDATE CONSTRAINT ck_sub_invoice_status;
ALTER TABLE print_jobs            VALIDATE CONSTRAINT ck_print_jobs_status;
ALTER TABLE journal_lines         VALIDATE CONSTRAINT ck_journal_line_one_side;
ALTER TABLE bill_items            VALIDATE CONSTRAINT ck_bill_items_qty_pos;
ALTER TABLE kot_items             VALIDATE CONSTRAINT ck_kot_items_qty_pos;
ALTER TABLE bank_statement_lines  VALIDATE CONSTRAINT fk_bank_line_statement_account;
ALTER TABLE products              VALIDATE CONSTRAINT fk_products_last_invoice;
