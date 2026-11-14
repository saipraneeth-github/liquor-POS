# 05 — Application impact

> Step 5. Maps every change to the features that use the affected tables and flags anything needing code changes.
> **Headline: no application code change is required to deploy Phases 1, 2 or 4.** The items below are things to *know*.

## 1. Phase 1 — indexes (no code change)

Indexes are invisible to SQL; the query planner picks them. Mapping of index → feature:

| Index | Feature / endpoint | Query shape |
|---|---|---|
| `idx_bills_branch_created` | `GET /bills`, dashboards (branch/owner), daily closing, consolidated invoices, counter-sheet "billed through POS", cashier dashboard | `branch_id = ? AND created_at >= ? [AND < ?] ORDER BY created_at DESC` |
| `idx_bills_shift`, `idx_bills_customer` | shift close totals; khata statement / credit bills | `shift_session_id = ?`, `customer_id = ?` |
| `idx_bill_items_bill`, `idx_bill_items_product` | bill detail, receipt, **void** (reverses stock per line), e-invoice; top sellers | `bill_id = ?`; join for reports |
| `idx_stock_audit_*`, `idx_stock_by_type_sale_type` | Excise & Breakage stock-audit, Counter Stock Sheet opening/inward/sold, Peg Control variance, sale-type movement history | `branch_id [+ product_id] + created_at`; `reference_id = sheet.id` |
| `idx_journal_vouchers_branch_date`, `idx_journal_lines_*`, `idx_expenses_branch_date` | Trial balance, P&L, Balance sheet, ledger entries, Tally export, expenses | voucher date range, then lines by voucher/ledger |
| `idx_bank_lines_voucher` | Bank reconciliation "posted" view | `voucher_id = ?` |
| `idx_tables_*`, `idx_table_sessions_*`, `idx_kot_*` | Tables & Orders (KOT): floor, open session, bill for session, kitchen tickets | `table_id + closed_at IS NULL`, `kot_order_id`, `table_session_id` |
| `idx_supplier_invoice*` | Supplier Invoices list/detail, scheme credit | `branch_id ORDER BY created_at`; `invoice_id` |
| `idx_schemes_*`, `idx_breakage_*`, `idx_pour_counts_*`, `idx_excise_quotas_branch` | Supplier Schemes, Excise & Breakage, Peg Control | branch (+status/date) |
| `idx_shift_sessions_branch_opened`, `idx_credit_txn_*` | Cashier Shift list; Customers & Khata statement | |
| `idx_branches_syndicate`, `idx_users_*`, `idx_products_category`, `idx_subscription_invoices_syn`, `idx_payment_orders_invoice`, `idx_audit_log_*` | tenancy resolution on every request (`getAccessibleBranchIds`), Staff list, Platform console/Users/Audit | |
| `idx_print_jobs_pending` | print queue sender + local print agent poll | `status='PENDING'` (partial) |

### Things to know (not bugs)

0. **Indexes can change the order of un-ordered queries.** One existing test (`counter-sheets.int.test.ts:473-478`, "approves surplus counts…") reads `stock_audit` with no `ORDER BY` and takes the *last* row as the latest. With `idx_stock_audit_branch_product` the planner returns index order (newest first), so the test sees the oldest row. Proven by adding `.orderBy(createdAt, id)` in a temporary copy: 16/16 pass. **Fix the test (add `.orderBy`)**; also audit production queries that rely on insertion order without an `ORDER BY` (none were found failing in the suite).
1. **Write cost.** Each insert into `bills`, `bill_items`, `stock_audit`, `journal_lines` now also maintains 2–3 extra indexes. Measured in `results/verification-results.md`. It is CPU/disk work inside the one transaction, **not extra network round trips**, so it does not interact with the "round trips are the cost on a hosted database" rule in AGENTS.md §8 (the 24-query bill budget is unchanged).
2. **Drizzle does not know these indexes.** They are not in `schema.ts` or the drizzle snapshot. Consequences:
   - `npm run db:generate` will **not** try to drop them (it diffs `schema.ts` against the snapshot, not the live DB).
   - **`npm run db:push` would drop them.** The project's documented workflow is generate + migrate, never push — keep it that way.
   - New environments created from `drizzle/*.sql` will not have them until they are added. Follow-up F-1 below.
3. **Neon pooled connections + `CREATE INDEX CONCURRENTLY`.** Must run on a *direct* (non-pooled) connection, outside a transaction. See runbook.

## 2. Phase 2 — constraints

A violating write now fails with Postgres `check_violation` (23514) / `foreign_key_violation` (23503). `sendError` (`src/lib/errors.ts`) already maps 23503 → **422** and 23505 → 409, but a **23514 check violation falls through to 500 with the message hidden**. Previously such a write would have *succeeded and stored bad data*.

| Constraint | Code paths that write the column | Can current code violate it? |
|---|---|---|
| ~~`ck_stock_qty_nonneg`, `ck_stock_by_type_nonneg`~~ | **Withdrawn.** Counter-sheet post upserts a (possibly negative) delta as the proposed row, which a CHECK rejects: 4 integration tests returned 500. Deferred until that write is changed (`sql/002b_stock_nonneg_DEFERRED.sql`). | **Yes — this is why it was withdrawn** |
| `ck_bills_payment_mode` | `billing.service` (`z.enum(PAYMENT_MODES)`) | No |
| `ck_credit_txn_pay_mode` | `customer.service` (`REPAYMENT_MODES`; NULL for purchases) | No |
| `ck_expenses_payment_mode` | `expense.service` (`EXPENSE_PAYMENT_MODES`) | No |
| `ck_bank_line_status`, `ck_bank_account_scope`, `ck_ledger_txn_direction` | `bank.service` | No — values are zod-enumerated; one-time check that no code writes another literal (grep done) |
| `ck_sub_invoice_status`, `ck_print_jobs_status` | `platform`, `plans.service`, `printing/*` (`PENDING/PAID/VOID`, `PENDING/SENT/FAILED`, `NETWORK/AGENT`) | No |
| `ck_journal_line_one_side` | `posting.service` | No — and it catches a future posting bug that wrote a negative or two-sided line |
| `ck_bill_items_qty_pos`, `ck_kot_items_qty_pos` | billing / kot | No (zod `.int().positive()`, `billing.service.ts:51`) |
| composite FK on `bank_statement_lines` | `bank.service` import (sets `accountId` from the statement's account) | No |
| `fk_products_last_invoice` | `invoice-workflow.service` approve | No — also `SET NULL` so a future draft delete cannot fail |

**Code follow-up (optional, recommended — F-2 below):** map `23514` to 422 in `sendError`, as 23503 already is, so a rejected write is a clear business error rather than a hidden 500.

## 3. Phase 4 — archive (only if adopted)

| Table | Code that reads old rows | Impact |
|---|---|---|
| `email_outbox` | `payment.routes.ts:106` shows only the newest 30 rows | none |
| `print_jobs` | queue reads `PENDING` only | none; failed jobs stay live |
| `password_resets` | reset flow reads by `token_hash` of a fresh token | none (only used/expired tokens older than 30 days move) |

## 4. Not changed — and therefore no impact

`schema.ts`, all `*.service.ts`, `drizzle/*`, the frontend, the seed data, the API contract.

## 5. Follow-ups that DO need code (proposed, not done)

| # | Follow-up | Why | Effort |
|---|---|---|---|
| F-1 | Declare the Phase-1 indexes in `schema.ts` (`index(...)` in each table's callback) and run `npm run db:generate` so fresh databases get them | keeps `schema.ts` the single source of truth; new dev/test DBs get the indexes | small; touches `schema.ts` + one generated migration |
| F-2 | Treat 23514 (check violation) like 23503 in `sendError` → 422 | clearer errors after Phase 2 | tiny |
| F-3 | Generated columns for `name_key`/`category_key` (R-4) | removes a drift risk | medium; services insert these explicitly |
| F-4 | Time-ordered UUIDs (v7) for the big tables | insert locality (F-07) | medium; needs Postgres 18 `uuidv7()` or app-side generation |
