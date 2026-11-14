# 04 — Referential-integrity check

> Step 4. Goal: after the proposed changes every relationship, constraint and cascade still holds. Proven mechanically by
> `sql/tests/t03_referential_integrity.sql` (generic — it enumerates **every** FK in the catalog) and by T05.

## 1. What each phase does to relationships

| Phase | Adds | Removes / alters | Effect on existing FKs, cascades, uniques |
|---|---|---|---|
| 1 — indexes | 41 b-tree indexes | nothing | **None.** Indexes cannot change which rows are valid. Existing FKs/cascades/unique rules are untouched. |
| 2 — constraints | 11 CHECKs, 1 composite FK, 1 FK, 1 unique | nothing | Only *adds* rules. Starts `NOT VALID` (guards new writes immediately), then `VALIDATE` proves old rows comply. A pre-check query set (`002_integrity_precheck.sql`) must return zero rows first. |
| 4 — archive | 3 `*_archive` tables (no FKs) | moves old rows out of 3 leaf tables | `email_outbox`, `print_jobs`, `password_resets` are **leaf** tables: nothing references them. `password_resets.user_id → users` remains on the live table. |

## 2. New relationships — cascade semantics chosen

| Constraint | Rule | Why this rule |
|---|---|---|
| `bank_statement_lines (statement_id, account_id) → bank_statements (id, account_id)` | `ON DELETE CASCADE` | identical to the two single-column cascades that already exist (statement delete and account delete both already remove lines). The composite FK adds *consistency*, not new deletion behaviour. |
| `products.last_invoice_id → supplier_invoices.id` | `ON DELETE SET NULL` | the product must survive; it is only a cache pointer. Approved invoices are never deleted anyway (reverse-only). |
| `UNIQUE (bank_statements.id, account_id)` | — | required target for the composite FK; `id` is already unique, so this is trivially satisfiable and cannot fail on existing data. |

## 3. Interaction with application code that reads the catalog

`tenant-lifecycle.service.ts` (permanent tenant delete) discovers ownership by reading `pg_constraint`:

- It selects **only single-column FKs** (`array_length(c.conkey,1) = 1`) → the new composite FK is **invisible** to it; the two single-column FKs it already relies on remain.
- `deletionOrder()` throws on circular references. The new edge `products → supplier_invoices` adds the order *items → products → invoices*, which is acyclic (items already depend on both). Exercised by the integration run recorded in `07-final-report.md` (tenant-lifecycle tests).

## 4. Verification queries (all in `sql/tests/`)

| Test | What it proves | Pass criterion |
|---|---|---|
| T03 | for every FK: count child rows with no parent; also lists any constraint still `NOT VALID` | result set empty |
| T05 | Phase-2 rules reject bad data (8 probes) and accept good data | all rows `ok = true` |
| T02 | business-level invariants (vouchers balance, stock ≥ 0, khata balance = last ledger row, bill numbers unique, every paid bill has lines) | every `violations = 0` |
| 002 pre-check | existing data already satisfies each new rule | zero rows |

Results of the run are in `results/verification-results.md`.

## 5. Residual gaps (not closed, by design)

| Gap | Why left open |
|---|---|
| "Every voucher balances" cannot be a CHECK (spans rows) | would need a deferred constraint trigger on `journal_lines`; invasive to posting. Covered by T02 instead, and by the app's `assertBalanced`. |
| `customers.current_credit` = last `balance_after` | cache consistency; same reason. T02. |
| `stock` total ≥ Σ `stock_by_type` | cross-table invariant; T02. |
| Enum-like text columns not in an exhaustive list (`audit_log.action`, `email_outbox.kind`, `print_jobs.kind`, `bank_*reason`) | open vocabularies that grow with features; a CHECK would make every new feature a migration. |
