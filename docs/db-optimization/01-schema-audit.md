# 01 — Schema audit

> Step 1 of the database optimisation. Everything here was measured from the real migrations and the real source code,
> not assumed. Reproduce with `node docs/db-optimization/scripts/audit-catalog.mjs` (read-only, in-memory scratch DB).

## 0. Assumptions and ground rules

| Topic | Decision |
|---|---|
| Engine | **PostgreSQL** (Drizzle ORM, `postgres-js` driver in production; embedded **PGlite** for dev/tests). The production database named in `.env` is a hosted Neon Postgres. |
| Where this was verified | A **throwaway in-memory PGlite** built by applying `drizzle/*.sql` in journal order (`scripts/lib.mjs`). The scripts never read `DATABASE_URL`, so they cannot touch a real database. **No SQL in this package was run against production.** |
| "Current schema" | `src/db/schema.ts` (1,082 lines) + the 25 migrations `drizzle/0000…0024`. They agree exactly (see §6 — zero drift). |
| Production data volume | Unknown to us (we have no access). Performance numbers are from synthetic data and are labelled as such. |
| Data safety | Phases 1 and 2 are **DDL only** (add indexes / add constraints). They move, rewrite and delete **no rows**. Both are reversible by a DOWN script that was tested. |
| Not touched | The shared user working tree. Nothing under `src/`, `frontend/` or `drizzle/` was modified by this work. |

## 1. Inventory

| Item | Count |
|---|---:|
| Tables | **64** |
| Migrations | 25 (`0000`–`0024`; **`0017`–`0024` are still untracked/uncommitted in git** — see risk R-3) |
| Enums | 18 (`user_role`, `bill_status`, `stock_reason`, `kot_*`, …) |
| Foreign keys | 133 (all single-column) |
| Primary keys | 63 of 64 tables: 61 surrogate `uuid` (`gen_random_uuid()`, v4), `saas_plans.code` (text), `branch_features` (composite). The 64th, `bill_counters`, has no PK but a `UNIQUE (branch_id, year)` and is only ever upserted (harmless; noted, not changed) |
| Secondary indexes (non-PK) | 52: 46 UNIQUE (business rules / unique constraints) and only **6 non-unique** performance indexes in the whole database |
| CHECK constraints | **0** |
| Widest tables | `supplier_invoices` 39 cols, `products` 26, `supplier_invoice_items` 26, `bank_statement_lines` 25, `daily_closings` 22, `bills` 20 |

### Data types — reviewed, no defects

| Concern | Finding |
|---|---|
| Money | All `numeric(p,s)`; no float columns; no `numeric` without precision. Cost prices use scale 6 on purpose (per-bottle cost from case rates). **Good.** |
| Time | Every instant is `timestamptz`; business dates are `date`. No `timestamp without time zone`. **Good.** |
| Identifiers | `uuid` everywhere. Random v4 keys scatter inserts across the PK index of the big append-only tables (`bills`, `stock_audit`, `journal_lines`) — a mild, long-term cost, not a defect. Informational (F-07). |
| Strings | `text` everywhere (no `varchar(n)`); correct for Postgres. |
| JSON | `jsonb` for flexible payloads (`features`, `denominations`, `extraction_meta`, `breakdown`, `meta`). Acceptable; none is filtered on in SQL. |
| Binary | `invoice_attachments.data` is `bytea` (scanned invoices). TOAST keeps it out of the main heap; only a problem if someone does `SELECT *` (see F-06). |

## 2. Findings

| ID | Severity | Finding | Evidence | Addressed by |
|---|---|---|---|---|
| **F-01** | **High** | **103 of 133 foreign keys have no index on the referencing column.** PostgreSQL does not create one automatically. Includes the hottest paths: `bill_items.bill_id`, `journal_lines.voucher_id`, `kot_items.kot_order_id`, `stock_audit.product_id`, `table_sessions.table_id`, `bills.shift_session_id`. Every bill detail, void, receipt, voucher view and KOT screen therefore does a **sequential scan of the whole child table**. | `audit-catalog.mjs` → "FOREIGN KEYS WITHOUT A COVERING INDEX" | Phase 1 |
| **F-02** | **High** | **No range index on the append-only history tables** that every report filters by date: `bills (branch_id, created_at)` (22 uses in code), `stock_audit` (10), `journal_vouchers (branch_id, voucher_date)` (18), `audit_log`, `supplier_invoices`, `shift_sessions`. 24 tables have no secondary index at all. | `query-usage.mjs`; catalog "Tables with NO secondary index" | Phase 1 |
| **F-03** | Medium | **No CHECK constraints anywhere.** 28 text columns behave as enums (`payment_mode`, `status`, `scope`, `direction`, …) and the database accepts any string. Quantities and journal amounts can be negative; a journal line can carry a debit *and* a credit. All of it is enforced only in TypeScript. | catalog "CHECK constraints present" = 0 | Phase 2 |
| **F-04** | Medium | `products.last_invoice_id` is a bare `uuid` with **no foreign key** — can point at an invoice that does not exist. | `schema.ts:138` | Phase 2 |
| **F-05** | Medium | `bank_statement_lines.account_id` is a denormalised copy of `statement → account`. Nothing stops a line from carrying a different account than its statement (which would break the per-account de-duplication `uq_bank_line_account_hash`). | `schema.ts:841-870` | Phase 2 |
| **F-06** | Low | **Unbounded growth, no retention**: `email_outbox` (full body stored), `print_jobs` (`payload` base64 of ESC/POS), `password_resets`, `dunning_log`, `invoice_attachments` (bytea). `audit_log` also grows forever but is intentionally kept. | row-write paths in `src/modules/{mail,printing,auth}` | Phase 4 (optional) |
| **F-07** | Info | Random UUIDv4 primary keys on the largest tables: poor insert locality, larger/bloatier PK indexes than time-ordered keys. | design | Recorded; no change (would need app change) |
| **F-08** | Low (doc) | `schema.ts:361` says the one-closing-per-day rule is an *expression index on `closing_date::date`*; the real index is `(branch_id, closing_date)` on a `timestamptz`. It **does** work, because `closing.service.ts:122` always stores the business-day start instant. It is therefore correct but fragile: changing `BUSINESS_UTC_OFFSET_MINUTES` later would let one date hold two closings. | `drizzle/0004`, `closing.service.ts:43,122` | Documented; no change |
| **F-09** | **Deployment risk** | Migrations `0017`–`0024` and `meta/_journal.json` are uncommitted. A production database that has not had `npm run db:migrate` run since those were written is **missing columns the code already reads** (AGENTS.md §8 warns a missing column fails every bill). | `git status` | Runbook pre-flight |
| **F-10** | Info | No stored object is orphaned or unreferenced: all 64 tables are read or written by `src/` (`scripts/usage-census.mjs`), so there is **no dead table**. | `usage.mjs` census | — |

## 3. Foreign keys without an index — outcome (measured by `scripts/fk-coverage.mjs`)

| | FKs without a covering index |
|---|---:|
| Today | **103** |
| After Phase 1 | **66** |
| Covered by Phase 1 | **37** |

("Covering" = some index whose first column is the FK column; an `IS NOT NULL` partial index counts, because FK look-ups only search real values.)

The 66 that remain are deliberate:

| Group | FKs | Why no index |
|---|---:|---|
| "Who did it" audit pointers — `created_by_id`, `recorded_by_id`, `approved_by_id`, `reviewed_by_id`, `rejected_by_id`, `reversed_by_id`, `updated_by_id`, `posted_by_id`, `resolved_by_id`, `uploaded_by_id`, `closed_by_id`, `opening_edited_by_id`, `adjustment_approved_by_id`, `actor_id`… | 25 | never filtered on. The application never deletes a user (verified: no `delete(users)` anywhere in `src/`), so the index would only serve a parent-delete check that does not happen. Each would cost write time and disk on every insert. |
| Everything else — `product_id` on history tables (stock_audit, kot_items, breakage, pour, price_audit, …), `sale_type_id` on small tables, `syndicate_id` on tiny tables, `role_id`, `terminal_id`, `serving_id`… | 41 | tiny parent/child, or always reached through a branch-led composite index that already narrows to a few rows (e.g. `stock_audit (branch_id, product_id, created_at)`). Listed in full by `fk-coverage.mjs`. |

> Consequence to accept knowingly: the Super-Admin **permanent tenant delete** walks foreign keys and deletes by those columns, so it
> will scan some large tables sequentially. It is a rare, manual, post-30-days operation, so it does not justify an index on every table.

## 4. Existing indexes — audit

All 52 existing secondary indexes were checked against each other:

- **Duplicate / strict-prefix redundant indexes: 0** (query: indexes whose column list is a prefix of another non-unique index on the same table).
- Unique indexes that double as lookups (`uq_branch_product`, `uq_stock_by_type`, `uq_bank_line_account_hash`, …) already cover the leading column, so no extra index is proposed for `stock.branch_id`, `stock_by_type.branch_id`, `bank_statement_lines.account_id`, `bank_statements.account_id`, `daily_counter_sheet_lines.sheet_id`.
- `uq_supplier_invoice_live_number` (partial: `status <> 'REJECTED' AND reversed_at IS NULL`) matches `schema.ts` exactly.
- `uq_daily_closing_branch_date`: see F-08.

**Result: nothing to drop.** The index problem is *absence*, not excess.

## 5. Referential rules already in place (inventory)

`ON DELETE CASCADE` is used for true parent→child ownership: `bill_items→bills`, `journal_lines→journal_vouchers`, `kot_items→kot_orders`, `supplier_invoice_items`/`invoice_attachments→supplier_invoices`, `scheme_slabs→schemes`, `bank_*` children → `bank_accounts`/`bank_statements`, `product_servings`/`product_prices`/`brand_code_mappings`→`products`, `user_*`→`users`. Everything else is `NO ACTION` (a parent with children cannot be deleted) — consistent with "bills and vouchers are never deleted".

## 6. Drift between `schema.ts` and the migrations

**0 differences.** Every column declared in `schema.ts` exists in the migrated database and vice-versa (`audit-catalog.mjs`, last section).

## 7. What was *not* found (so nobody re-investigates)

- No float money columns, no timestamp-without-zone, no missing primary keys.
- No orphan tables, no duplicate indexes.
- No table that should be merged for performance reasons (see `02-redundancy-analysis.md` for the merge candidates considered and rejected).
