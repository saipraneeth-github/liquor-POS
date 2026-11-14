# 02 — Redundancy analysis

> Step 2. Every candidate was checked against the code that reads and writes it. Verdicts: **KEEP** (intentional, needed),
> **CHANGE** (a change is proposed), **DEFER** (worth doing later, needs an application change), **REJECT** (looked at, not worth it).

## 1. Summary

| Kind | Found | Removed by this work |
|---|---:|---:|
| Unused / obsolete **tables** | 0 | 0 |
| Redundant / duplicate **indexes** | 0 | 0 |
| Duplicated data that can drift (needs a guard) | 3 | guarded by constraints (Phase 2) except stock (withdrawn) |
| Intentional denormalisation (snapshots, caches) | 9 | 0 — kept on purpose |
| Dead columns | 2 (`categories.tax_type`, `bill_items.tax_type`) | 0 — REJECT, see R-3 |
| Unbounded-growth tables | 4 | optional archive (Phase 4) |

**Honest headline: this schema is not bloated with redundancy. The real problems are missing indexes and missing constraints.**
Nothing is dropped, so no data can be lost by this package.

## 2. Table-level

| Table | Used by | Verdict | Notes |
|---|---|---|---|
| All 64 | `src/` references (`scripts/usage-census.mjs`; min 2 refs: `dunning_log`) | KEEP | no dead table |
| `ledger_transactions` | bank search screen (6 refs) | KEEP, flagged | A **projection** of `bank_statement_lines` + `journal_vouchers` (date, description, amount, direction, voucher). A second copy that can diverge; `source='MANUAL'` is never written yet. Kept: it makes search one table. Divergence is covered by test T02/T03 and the guarded unique `bank_line_id`. |
| `serving_price_audit` vs `price_audit` | two parallel price-history tables | REJECT merge | different parents (`product_servings` vs `products`), different consumers; merging adds a nullable FK pair and a code change for no read benefit. |
| `branch_sale_types`, `user_sale_types`, `user_page_permissions`, `product_prices` | junction tables with an unused surrogate `id` | KEEP | the `id` is unused but harmless; changing a PK means rewriting FKs and Drizzle code for ~16 bytes/row. |
| `roles` + `users.role` + `users.role_id` | two ways to say "role" | KEEP | by design: `role` = level every guard reads, `role_id` = custom role (AGENTS.md). |

## 3. Column-level

| ID | Columns | Redundant with | Verdict | Reason / impact of removal |
|---|---|---|---|---|
| R-1 | `bank_statement_lines.account_id` | `statement → account` | **CHANGE (guard)** | Needed: `uq_bank_line_account_hash (account_id, hash)` de-duplicates across statements. But nothing proved the copy correct. Phase 2 adds `UNIQUE(bank_statements.id, account_id)` + composite FK so the database enforces equality. Removal would break overlap-safe re-upload. |
| R-2 | `products.last_invoice_id/_number/_date`, `previous_cost_price`, `cost_per_case`, `cost_updated_at` | latest approved `supplier_invoice_items` row | **KEEP + guard** | A cache so the product list needs no join (read in 24 places). `last_invoice_id` had no FK (F-04) — Phase 2 adds `ON DELETE SET NULL`. Removal would force a join/lateral on every product list. |
| R-3 | `categories.tax_type`, `bill_items.tax_type` (enum `tax_type`: `GST`/`VAT_EXCISE`) | nothing branches on it | **REJECT** | Only read once (`product.service.ts:38`, echoed to the API); never written, so always `GST`. Dropping saves 4 bytes/line and needs an enum drop + API/UI check. Not worth the risk; recorded as DEFER-able clean-up. |
| R-4 | `roles.name_key`, `bank_transaction_types.name_key`, `ledger_transactions.category_key` | `lower(name)` / `lower(category)` | **DEFER** | Could be `GENERATED ALWAYS AS (lower(name)) STORED`, but the services insert these columns explicitly — a generated column rejects that, so it needs code edits. Kept. |
| R-5 | `supplier_invoices`: `total_amount`, `total_invoice_amount`, `net_invoice_value`, `sub_total`, `lines_basic_total`, `challan_amount`, `retailer_credit_balance` | each other (look alike) | **KEEP** | Each is a distinct printed field of the Telangana/ICDC depot invoice (used by the challan reconciliation: 10–13 code references each). They are *captured*, not derived. Merging would destroy reconciliation. |
| R-6 | `supplier_invoice_items.previous_cost_price`, `cost_difference`, `cost_increase_pct` | `cost_price` − previous | **KEEP** | Snapshot at approval time. `products.previous_cost_price` moves on later invoices, so these preserve history. |
| R-7 | `bills.subtotal/tax_amount/total`, `bill_items.tax_amount/line_total` | sums of lines | **KEEP** | Legal record of what the customer was charged (GST back-calculated per line after discount allocation). Must never be recomputed. |
| R-8 | `daily_closings.*Sales`, `*BillsCount`; `shift_sessions.*Collected`; `consolidated_invoices.gross_sales/bill_count/breakdown` | aggregates of `bills` | **KEEP** | Immutable end-of-day / end-of-shift records; AGENTS.md notes a later void is *not* reflected. Recomputing would rewrite history. |
| R-9 | `customers.current_credit` | `credit_transactions.balance_after` (last row) | **KEEP + test** | Running balance cache. Test T02 asserts they agree. |
| R-10 | `schemes.current_value` | `Σ scheme_purchases.value` | **KEEP** | cache; updated with each purchase. |
| R-11 | `stock.quantity` vs `Σ stock_by_type` | documented invariant | **KEEP + guard** | `quantity >= 0` was tried and **withdrawn** (breaks the delta-upsert in counter-sheet posting, see 03); T02 asserts `≥ 0` and `Σ explicit ≤ total`. |
| R-12 | `daily_counter_sheet_lines.opening_system` | `opening_bottles` | **KEEP** | stores the system value when a person edits the opening (audit). |

## 4. Growth without retention (storage, not duplication)

| Table | What accumulates | Proposal |
|---|---|---|
| `email_outbox` | full e-mail body forever | archive rows older than 90 days (Phase 4, opt-in) |
| `print_jobs` | `SENT` rows with base64 ESC/POS `payload` | archive `SENT` older than 30 days; the partial index keeps the live queue fast regardless |
| `password_resets` | used/expired tokens | archive older than 30 days |
| `dunning_log` | tiny, one row per reminder | no action |
| `audit_log` | every platform action | **never delete** (the tenant-delete design keeps it deliberately) |
| `invoice_attachments.data` (bytea) | every scanned invoice | no change now; if hosted storage cost matters, move to object storage later (application change) |

Phase 4 **moves** rows to `*_archive` tables inside one transaction (copy, verify count, then delete) — it never discards data. See `sql/004_retention_archive_*.sql`.

## 5. Impact if the "REJECT/DEFER" items were removed anyway

| Item | If removed | Verdict |
|---|---|---|
| `tax_type` columns | 2 column drops + enum drop; API shape of `/products` categories changes | not worth it |
| Snapshot columns (R-6, R-7, R-8) | history becomes recomputed → legal/audit records change after the fact | unacceptable |
| `account_id` copy (R-1) | cross-statement de-duplication breaks → duplicate bank lines | unacceptable |
