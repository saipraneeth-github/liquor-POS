-- 0025_db_optimization: database optimisation (docs/db-optimization).
-- Part 1: 41 indexes. Part 2: 11 CHECK constraints, 1 composite FK + 1 unique, 1 FK (added NOT VALID, then validated).
-- Adds indexes and rules. The ONLY data change: products.last_invoice_id values that point at a deleted invoice are copied to
-- products_last_invoice_orphans_backup and then set to NULL (what ON DELETE SET NULL would have done). If any other row violates a
-- rule, VALIDATE fails and this whole migration rolls back.
-- Undo by hand with docs/db-optimization/sql/002_integrity_down.sql then 001_indexes_down.sql.
-- Source of truth: docs/db-optimization/sql/001_indexes_up.sql and 002_integrity_up.sql (regenerate with scripts/make-migration.mjs).
-- ============================================================================
-- Phase 1 (UP) — additive indexes.  No data is changed, moved or deleted.
-- Reversible with 001_indexes_down.sql (DROP INDEX only).
--
-- Every index below is justified in docs/db-optimization/03-proposed-changes.md
-- by a query found in src/ (see scripts/query-usage.mjs) — nothing is indexed "just because".
-- The ~60 "who did it" foreign keys (created_by_id, recorded_by_id, ...) are intentionally NOT indexed.
--
-- PRODUCTION: run 001_indexes_up_concurrent.sql instead (same statements, CREATE INDEX CONCURRENTLY, takes no write lock).
-- It must be run outside a transaction, so it can NOT go through the Drizzle migrator (which wraps a file in one).
-- ============================================================================

-- ── Sales: the busiest tables ───────────────────────────────────────────────
-- GET /bills, dashboards, daily closing, consolidated invoices: branch + created_at range, newest first.
CREATE INDEX IF NOT EXISTS idx_bills_branch_created        ON bills (branch_id, created_at DESC);
--> statement-breakpoint
-- shift close sums the bills of one shift; khata statement joins bills by customer. Partial: most bills have neither.
CREATE INDEX IF NOT EXISTS idx_bills_shift                 ON bills (shift_session_id) WHERE shift_session_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bills_customer              ON bills (customer_id)      WHERE customer_id IS NOT NULL;
--> statement-breakpoint
-- bill detail, void, receipt, e-invoice: ALL read items by bill_id. Today this is a sequential scan of every bill line ever sold.
CREATE INDEX IF NOT EXISTS idx_bill_items_bill             ON bill_items (bill_id);
--> statement-breakpoint
-- top sellers / product movement reports
CREATE INDEX IF NOT EXISTS idx_bill_items_product          ON bill_items (product_id);
--> statement-breakpoint
-- ── Stock movement history ──────────────────────────────────────────────────
-- stock-audit screen, counter-sheet opening/inward/sold, pour variance: branch (+product) over a date range.
CREATE INDEX IF NOT EXISTS idx_stock_audit_branch_created  ON stock_audit (branch_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stock_audit_branch_product  ON stock_audit (branch_id, product_id, created_at DESC);
--> statement-breakpoint
-- counter-sheet post / un-post finds its own movements by reference_id (= sheet id)
CREATE INDEX IF NOT EXISTS idx_stock_audit_reference       ON stock_audit (reference_id) WHERE reference_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stock_by_type_sale_type     ON stock_by_type (sale_type_id);
--> statement-breakpoint
-- ── Accounting ──────────────────────────────────────────────────────────────
-- trial balance / P&L / balance sheet / Tally export: vouchers of a branch in a date range, then their lines.
CREATE INDEX IF NOT EXISTS idx_journal_vouchers_branch_date ON journal_vouchers (branch_id, voucher_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_journal_lines_voucher       ON journal_lines (voucher_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_journal_lines_ledger        ON journal_lines (ledger_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date        ON expenses (branch_id, expense_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_lines_voucher          ON bank_statement_lines (voucher_id) WHERE voucher_id IS NOT NULL;
--> statement-breakpoint
-- ── Bar: tables, sessions, KOT ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tables_branch               ON tables (branch_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_table_sessions_table_open   ON table_sessions (table_id, closed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_table_sessions_branch_open  ON table_sessions (branch_id, closed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_table_sessions_bill         ON table_sessions (bill_id) WHERE bill_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kot_orders_session          ON kot_orders (table_session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kot_orders_branch_created   ON kot_orders (branch_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kot_items_order             ON kot_items (kot_order_id);
--> statement-breakpoint
-- ── Purchases, schemes, compliance ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_branch_created ON supplier_invoices (branch_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_invoice   ON supplier_invoice_items (invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_product  ON supplier_invoice_items (product_id) WHERE product_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_schemes_branch_status       ON schemes (branch_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scheme_purchases_scheme     ON scheme_purchases (scheme_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_breakage_branch_created     ON breakage_logs (branch_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pour_counts_branch_created  ON pour_counts (branch_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_excise_quotas_branch        ON excise_quotas (branch_id, period_start);
--> statement-breakpoint
-- ── Registers & khata ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shift_sessions_branch_opened ON shift_sessions (branch_id, opened_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_credit_txn_customer_recorded ON credit_transactions (customer_id, recorded_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_credit_txn_bill             ON credit_transactions (bill_id) WHERE bill_id IS NOT NULL;
--> statement-breakpoint
-- ── Tenancy, catalogue, platform console ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_branches_syndicate          ON branches (syndicate_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_branch                ON users (branch_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_syndicate             ON users (syndicate_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_products_category           ON products (category_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_invoices_syn   ON subscription_invoices (syndicate_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payment_orders_invoice      ON payment_orders (invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_created           ON audit_log (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_actor             ON audit_log (actor_id) WHERE actor_id IS NOT NULL;
--> statement-breakpoint
-- the print queue (network sender and agent poll) only ever reads PENDING rows, so the index holds only those (a handful)
-- however large the table grows; the agent's extra branch_id filter is applied to that handful
CREATE INDEX IF NOT EXISTS idx_print_jobs_pending          ON print_jobs (target, next_attempt_at) WHERE status = 'PENDING';
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE credit_transactions   ADD CONSTRAINT ck_credit_txn_pay_mode    CHECK (payment_mode IS NULL OR payment_mode IN ('CASH','CARD','UPI')) NOT VALID;
--> statement-breakpoint
ALTER TABLE expenses              ADD CONSTRAINT ck_expenses_payment_mode   CHECK (payment_mode IN ('CASH','CARD','UPI','BANK')) NOT VALID;
--> statement-breakpoint
ALTER TABLE bank_statement_lines  ADD CONSTRAINT ck_bank_line_status        CHECK (status IN ('UNMATCHED','SUGGESTED','MATCHED','IGNORED')) NOT VALID;
--> statement-breakpoint
ALTER TABLE bank_accounts         ADD CONSTRAINT ck_bank_account_scope      CHECK (scope IN ('BRANCH','SYNDICATE')) NOT VALID;
--> statement-breakpoint
ALTER TABLE ledger_transactions   ADD CONSTRAINT ck_ledger_txn_direction    CHECK (direction IN ('DEBIT','CREDIT')) NOT VALID;
--> statement-breakpoint
ALTER TABLE subscription_invoices ADD CONSTRAINT ck_sub_invoice_status      CHECK (status IN ('PENDING','PAID','VOID')) NOT VALID;
--> statement-breakpoint
ALTER TABLE print_jobs            ADD CONSTRAINT ck_print_jobs_status       CHECK (status IN ('PENDING','SENT','FAILED') AND target IN ('NETWORK','AGENT')) NOT VALID;
--> statement-breakpoint
ALTER TABLE journal_lines         ADD CONSTRAINT ck_journal_line_one_side   CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE bill_items            ADD CONSTRAINT ck_bill_items_qty_pos      CHECK (quantity > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE kot_items             ADD CONSTRAINT ck_kot_items_qty_pos       CHECK (quantity > 0) NOT VALID;
--> statement-breakpoint
-- bank_statement_lines.account_id is a copy of statement -> account. Make the database prove the copy is right.
ALTER TABLE bank_statements ADD CONSTRAINT uq_bank_statement_id_account UNIQUE (id, account_id);
--> statement-breakpoint
ALTER TABLE bank_statement_lines ADD CONSTRAINT fk_bank_line_statement_account
  FOREIGN KEY (statement_id, account_id) REFERENCES bank_statements (id, account_id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
-- Dangling pointers found on real data (invoices deleted while a product still cached their id). Back them up first, then clear
-- them: exactly what ON DELETE SET NULL would have done. last_invoice_number / last_invoice_date stay, so nothing readable is lost.
CREATE TABLE IF NOT EXISTS products_last_invoice_orphans_backup (
  product_id uuid PRIMARY KEY, last_invoice_id uuid, last_invoice_number text, last_invoice_date timestamptz, backed_up_at timestamptz DEFAULT now()
);
--> statement-breakpoint
INSERT INTO products_last_invoice_orphans_backup (product_id, last_invoice_id, last_invoice_number, last_invoice_date)
  SELECT p.id, p.last_invoice_id, p.last_invoice_number, p.last_invoice_date FROM products p
  WHERE p.last_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = p.last_invoice_id)
  ON CONFLICT (product_id) DO NOTHING;
--> statement-breakpoint
UPDATE products p SET last_invoice_id = NULL
  WHERE p.last_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = p.last_invoice_id);
--> statement-breakpoint
-- products.last_invoice_id was a bare uuid with no FK: a dangling pointer is possible. SET NULL keeps the product.
ALTER TABLE products ADD CONSTRAINT fk_products_last_invoice
  FOREIGN KEY (last_invoice_id) REFERENCES supplier_invoices (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
-- ── Step B: validate (scans old rows, does not block normal traffic) ───────
ALTER TABLE bills                 VALIDATE CONSTRAINT ck_bills_payment_mode;
--> statement-breakpoint
ALTER TABLE credit_transactions   VALIDATE CONSTRAINT ck_credit_txn_pay_mode;
--> statement-breakpoint
ALTER TABLE expenses              VALIDATE CONSTRAINT ck_expenses_payment_mode;
--> statement-breakpoint
ALTER TABLE bank_statement_lines  VALIDATE CONSTRAINT ck_bank_line_status;
--> statement-breakpoint
ALTER TABLE bank_accounts         VALIDATE CONSTRAINT ck_bank_account_scope;
--> statement-breakpoint
ALTER TABLE ledger_transactions   VALIDATE CONSTRAINT ck_ledger_txn_direction;
--> statement-breakpoint
ALTER TABLE subscription_invoices VALIDATE CONSTRAINT ck_sub_invoice_status;
--> statement-breakpoint
ALTER TABLE print_jobs            VALIDATE CONSTRAINT ck_print_jobs_status;
--> statement-breakpoint
ALTER TABLE journal_lines         VALIDATE CONSTRAINT ck_journal_line_one_side;
--> statement-breakpoint
ALTER TABLE bill_items            VALIDATE CONSTRAINT ck_bill_items_qty_pos;
--> statement-breakpoint
ALTER TABLE kot_items             VALIDATE CONSTRAINT ck_kot_items_qty_pos;
--> statement-breakpoint
ALTER TABLE bank_statement_lines  VALIDATE CONSTRAINT fk_bank_line_statement_account;
--> statement-breakpoint
ALTER TABLE products              VALIDATE CONSTRAINT fk_products_last_invoice;
