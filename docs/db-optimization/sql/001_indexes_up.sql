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
-- shift close sums the bills of one shift; khata statement joins bills by customer. Partial: most bills have neither.
CREATE INDEX IF NOT EXISTS idx_bills_shift                 ON bills (shift_session_id) WHERE shift_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_customer              ON bills (customer_id)      WHERE customer_id IS NOT NULL;
-- bill detail, void, receipt, e-invoice: ALL read items by bill_id. Today this is a sequential scan of every bill line ever sold.
CREATE INDEX IF NOT EXISTS idx_bill_items_bill             ON bill_items (bill_id);
-- top sellers / product movement reports
CREATE INDEX IF NOT EXISTS idx_bill_items_product          ON bill_items (product_id);

-- ── Stock movement history ──────────────────────────────────────────────────
-- stock-audit screen, counter-sheet opening/inward/sold, pour variance: branch (+product) over a date range.
CREATE INDEX IF NOT EXISTS idx_stock_audit_branch_created  ON stock_audit (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_audit_branch_product  ON stock_audit (branch_id, product_id, created_at DESC);
-- counter-sheet post / un-post finds its own movements by reference_id (= sheet id)
CREATE INDEX IF NOT EXISTS idx_stock_audit_reference       ON stock_audit (reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_by_type_sale_type     ON stock_by_type (sale_type_id);

-- ── Accounting ──────────────────────────────────────────────────────────────
-- trial balance / P&L / balance sheet / Tally export: vouchers of a branch in a date range, then their lines.
CREATE INDEX IF NOT EXISTS idx_journal_vouchers_branch_date ON journal_vouchers (branch_id, voucher_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_voucher       ON journal_lines (voucher_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_ledger        ON journal_lines (ledger_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date        ON expenses (branch_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_bank_lines_voucher          ON bank_statement_lines (voucher_id) WHERE voucher_id IS NOT NULL;

-- ── Bar: tables, sessions, KOT ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tables_branch               ON tables (branch_id);
CREATE INDEX IF NOT EXISTS idx_table_sessions_table_open   ON table_sessions (table_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_table_sessions_branch_open  ON table_sessions (branch_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_table_sessions_bill         ON table_sessions (bill_id) WHERE bill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kot_orders_session          ON kot_orders (table_session_id);
CREATE INDEX IF NOT EXISTS idx_kot_orders_branch_created   ON kot_orders (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kot_items_order             ON kot_items (kot_order_id);

-- ── Purchases, schemes, compliance ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_branch_created ON supplier_invoices (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_invoice   ON supplier_invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_product  ON supplier_invoice_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_schemes_branch_status       ON schemes (branch_id, status);
CREATE INDEX IF NOT EXISTS idx_scheme_purchases_scheme     ON scheme_purchases (scheme_id);
CREATE INDEX IF NOT EXISTS idx_breakage_branch_created     ON breakage_logs (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pour_counts_branch_created  ON pour_counts (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_excise_quotas_branch        ON excise_quotas (branch_id, period_start);

-- ── Registers & khata ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shift_sessions_branch_opened ON shift_sessions (branch_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_txn_customer_recorded ON credit_transactions (customer_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_txn_bill             ON credit_transactions (bill_id) WHERE bill_id IS NOT NULL;

-- ── Tenancy, catalogue, platform console ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_branches_syndicate          ON branches (syndicate_id);
CREATE INDEX IF NOT EXISTS idx_users_branch                ON users (branch_id);
CREATE INDEX IF NOT EXISTS idx_users_syndicate             ON users (syndicate_id);
CREATE INDEX IF NOT EXISTS idx_products_category           ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_subscription_invoices_syn   ON subscription_invoices (syndicate_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_invoice      ON payment_orders (invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created           ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor             ON audit_log (actor_id) WHERE actor_id IS NOT NULL;
-- the print queue (network sender and agent poll) only ever reads PENDING rows, so the index holds only those (a handful)
-- however large the table grows; the agent's extra branch_id filter is applied to that handful
CREATE INDEX IF NOT EXISTS idx_print_jobs_pending          ON print_jobs (target, next_attempt_at) WHERE status = 'PENDING';
