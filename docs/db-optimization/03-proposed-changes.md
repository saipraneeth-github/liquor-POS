# 03 — Proposed normalisation and clean-up changes

> Step 3. Exact DDL lives in `sql/` (so it can be run, diffed and tested); this page explains each change. Every migration is
> **reversible** and **moves no data** except Phase 4, which moves rows to archive tables and can move them back.

## Overview

| Phase | File(s) | What | Data touched | Reversible by | Risk |
|---|---|---|---|---|---|
| **1** | `001_indexes_up.sql` (+`_concurrent`) | 41 indexes | none | `001_indexes_down.sql` (+`_concurrent`) | Low |
| **2** | `002_integrity_precheck.sql`, `002_integrity_up.sql` | 11 CHECKs, 1 composite FK + 1 unique, 1 FK | none (adds rules) | `002_integrity_down.sql` | Medium |
| **3** | — | *Normalisation / merges / drops* | — | — | **None proposed** — see below |
| **4** | `004_retention_archive_up.sql` | archive old e-mail / print / reset rows | moved, not removed | `004_retention_archive_down.sql` | Low, optional |

### Why there is no "Phase 3" (merge / drop / re-type)

The brief asked for merges, drops and type changes where justified. The audit (`01`, `02`) found **no justified one**:

- no duplicate or dead table or index → nothing to merge or drop;
- the near-duplicate columns are captured source fields or legal snapshots (R-5…R-8), which must not be recomputed;
- the only dead columns (`tax_type`) are 4 bytes a row and tied to an enum and an API shape (R-3);
- generated columns (R-4) and UUIDv7 (F-07) need application changes and are listed as follow-ups, not forced into a "migration".

Proposing structural change for its own sake in a live billing/accounting database would add risk without benefit. This is a finding, not an omission.

## Phase 1 — indexes (`sql/001_indexes_up.sql`)

41 statements. Design rules applied:

- **Lead with the equality column, then the range/sort column** (`branch_id, created_at DESC`) — one index serves "bills of this branch today, newest first" *and* "sum for a day".
- **Partial indexes** where most rows have no value (`bills.shift_session_id`, `bills.customer_id`, `stock_audit.reference_id`, `credit_transactions.bill_id`, …) → small, cheap to maintain.
- **`idx_print_jobs_pending`** is partial on `status='PENDING'`, so it stays a few rows no matter how many sent jobs exist.
- **Not indexed on purpose:** the 25 "who did it" pointers and 41 low-value FKs (`01` §3).

Excerpt (full file in `sql/`):

```sql
CREATE INDEX IF NOT EXISTS idx_bills_branch_created   ON bills (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill        ON bill_items (bill_id);
CREATE INDEX IF NOT EXISTS idx_stock_audit_branch_product ON stock_audit (branch_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_vouchers_branch_date ON journal_vouchers (branch_id, voucher_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_voucher  ON journal_lines (voucher_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_pending     ON print_jobs (target, next_attempt_at) WHERE status = 'PENDING';
```

Production uses the `_concurrent` twin generated from the same file (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`).

**Data migration needed:** none. **Rollback:** `001_indexes_down.sql` (41 × `DROP INDEX IF EXISTS`).

## Phase 2 — integrity (`sql/002_integrity_up.sql`)

Pattern for each rule: `ADD CONSTRAINT … NOT VALID` (instant; guards new writes) → later `VALIDATE CONSTRAINT` (checks old rows without blocking traffic).

| Constraint | Rule | Finding it closes |
|---|---|---|
| ~~`ck_stock_qty_nonneg`, `ck_stock_by_type_nonneg`~~ | `quantity >= 0` — **withdrawn, see below** | F-03 |
| `ck_bills_payment_mode`, `ck_credit_txn_pay_mode`, `ck_expenses_payment_mode` | value ∈ the set the zod enums allow | F-03 |
| `ck_bank_line_status`, `ck_bank_account_scope`, `ck_ledger_txn_direction`, `ck_sub_invoice_status`, `ck_print_jobs_status` | closed vocabularies | F-03 |
| `ck_journal_line_one_side` | `debit>=0 AND credit>=0 AND (debit=0 OR credit=0)` | F-03 (double-entry safety) |
| `ck_bill_items_qty_pos`, `ck_kot_items_qty_pos` | `quantity > 0` | F-03 |
| `uq_bank_statement_id_account` + `fk_bank_line_statement_account` | `(statement_id, account_id)` must match the statement's account | F-05 |
| `fk_products_last_invoice` (`ON DELETE SET NULL`) | pointer must exist | F-04 |

Why `CHECK` and not new enums: widening an enum needs a migration and (per AGENTS.md, the `roles.level` note) enum values cannot be used in the migration that adds them; a `CHECK … IN (…)` is a one-line change later.

**Data migration needed:** none, *provided* `002_integrity_precheck.sql` returns zero rows. If it does not, the rows are listed so they can be corrected deliberately; the constraint is never forced.
**Rollback:** `002_integrity_down.sql`.

### Withdrawn: stock `quantity >= 0` (found by running the app's own tests)

The first draft of Phase 2 included `CHECK (quantity >= 0)` on `stock` and `stock_by_type`. Running the project's integration suite against it made **4 counter-sheet tests return HTTP 500**. Cause: `counter.service.ts` (lines ~648, ~656) writes stock as `INSERT … VALUES (<delta, may be negative>) ON CONFLICT DO UPDATE SET quantity = quantity + EXCLUDED.quantity`. PostgreSQL evaluates a CHECK on the *proposed* row before resolving the conflict, so a negative delta is rejected even though the stored result would be fine. The rule is kept in `sql/002b_stock_nonneg_DEFERRED.sql` with the code change it needs (turn that write into an `UPDATE … SET quantity = quantity + delta` for existing rows). Stock non-negativity is still *tested* (T02) rather than *enforced*.

## Phase 4 — retention (`sql/004_retention_archive_up.sql`, optional)

```sql
CREATE TABLE IF NOT EXISTS email_outbox_archive (LIKE email_outbox INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
WITH moved AS (DELETE FROM email_outbox WHERE created_at < now() - interval '90 days' RETURNING *)
INSERT INTO email_outbox_archive SELECT * FROM moved;      -- one atomic statement: in live OR archive, never both/neither
```
Same pattern for finished `print_jobs` (30 d) and used/expired `password_resets` (30 d). Tested to preserve every row and restore exactly (`scripts/test-phase4.mjs`).

## Not proposed (explicit)

| Idea | Decision |
|---|---|
| Drop `tax_type` columns / enum | REJECT (R-3) |
| Merge `price_audit` + `serving_price_audit` | REJECT |
| Generated `*_key` columns | DEFER (needs code) |
| UUIDv7 keys | DEFER (needs code / PG 18) |
| Partition `bills` / `stock_audit` / `journal_lines` | not needed at this scale; revisit at ~50 M rows |
| Move `invoice_attachments.data` to object storage | DEFER |
