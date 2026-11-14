# 07 — Final report

> Step 7. Every number below is copied from a recorded run in `results/` (or the baseline logs); none is estimated.
> Scale of the performance run: **45,000 bills, 112,500 bill lines, 112,500 stock-audit rows, 135,000 journal lines** on an in-memory PGlite database (synthetic data; real production volumes are unknown to us).

## 1. Status

| | |
|---|---|
| Applied to a real database | **No.** The Neon URL in `.env` did not resolve from the author's machine (DNS `ENOTFOUND` for both the pooled and direct host), so nothing could be applied. Everything was verified on throw-away local databases. |
| Application code changed | **No** (`src/`, `frontend/`, `drizzle/`, `schema.ts` untouched; the migration journal was restored byte-for-byte after every temporary use). |
| Data lost / altered by any phase | **None** (fingerprint test passes after Phase 1, Phase 2, and after rollback). |

## 2. Schema before → after

| | Before | After Phases 1+2 |
|---|---:|---:|
| Tables | 64 | 64 (+3 archive tables only if optional Phase 4 is run) |
| Columns | unchanged | unchanged |
| Non-unique performance indexes | **6** | **47** (+41) |
| Foreign keys with no covering index | 103 of 133 | 66 of 133 (the remaining 66 are deliberate, `01` §3) |
| CHECK constraints | **0** | **11** |
| Foreign keys | 133 | 135 (+2: one composite FK on `bank_statement_lines`, and `products.last_invoice_id`, which previously had none) |
| Index size (45k-bill data set) | 39 MB | 73 MB (+34 MB, tables 95 → 100 MB) |

## 3. Redundancies removed

**None removed — by finding, not omission.** No dead table, no duplicate index, and every near-duplicate column is a legal snapshot or a captured source field (`02`). What *was* found and handled:

| Item | Action |
|---|---|
| Duplicated `bank_statement_lines.account_id` could drift from its statement | now **guarded** by a composite FK |
| `products.last_invoice_id` had no FK | **guarded** (`ON DELETE SET NULL`) |
| 28 enum-like text columns unguarded | 11 **guarded** by CHECKs |
| Unbounded growth (`email_outbox`, `print_jobs`, `password_resets`) | optional archive (Phase 4), tested lossless |
| `tax_type` dead columns, generated `*_key` columns, UUIDv7 | **deferred / rejected** with reasons |

## 4. Performance (read) — `results/verification-results.md`

Median of 7 `EXPLAIN (ANALYZE)` runs; "pages" = shared buffers touched.

| Query (from the app) | Before | After | Speed-up | Plan change |
|---|---:|---:|---:|---|
| Q01 Bills list, newest first | 37.4 ms | 0.69 ms | **54×** | Seq Scan → Index |
| Q02 Closing: one day's sales | 37.1 ms | 0.54 ms | **69×** | Seq → Bitmap |
| Q03 Bill detail / void / receipt lines | 40.5 ms | 0.08 ms | **519×** | Seq → Bitmap |
| Q04 Dashboard top sellers (7 d) | 387 ms | 15.3 ms | **25×** | Seq → Index |
| Q05 Shift close | 27.5 ms | 1.30 ms | **21×** | Seq → Bitmap |
| Q06 Stock audit of a product | 46.8 ms | 1.11 ms | **42×** | Seq → Bitmap |
| Q07 Counter-sheet movements by reference | 50.0 ms | 0.09 ms | **582×** | Seq → Bitmap |
| Q08 Trial balance (one month) | 397 ms | 49.0 ms | **8.1×** | Seq → Bitmap/Index |
| Q09 Voucher lines | 47.8 ms | 0.20 ms | **235×** | Seq → Bitmap |
| Q10 Ledger entries (one month) | 161 ms | 80.5 ms | **2.0×** | Seq → Bitmap |
| Q11 KOT items | 46.6 ms | 0.13 ms | **373×** | Seq → Bitmap |
| Q12 Open session of a table | 18.0 ms | 0.08 ms | **214×** | Seq → Index |
| Q13 Khata statement | 4.33 ms | 0.39 ms | **11×** | Seq → Bitmap |
| Q14 Supplier invoice lines | 5.81 ms | 0.18 ms | **32×** | Seq → Bitmap |
| Q15 Supplier invoices list | 5.58 ms | 0.73 ms | **7.7×** | Seq → Index |
| Q16 Print queue | 8.88 ms | 0.11 ms | **79×** | Seq → Index (partial) |
| Q17 Platform audit log | 32.5 ms | 0.66 ms | **49×** | Seq → Index |
| Q18 Khata credit bills | 69.2 ms | 0.50 ms | **138×** | Seq → Bitmap |

All 18 queries return **identical results** before and after (row count + content hash).
Read how to interpret this honestly: the gain grows with table size (a sequential scan is O(n), an index lookup is not); on a small shop's data the absolute saving is smaller. Q08/Q10 (accounting aggregates) gain least because they must still read many rows.

### Cost side

| | Before | After | Change |
|---|---:|---:|---:|
| Insert 5,000 bills + 5,000 lines + 5,000 stock-audit rows | 1,879 ms | 2,261 ms | **+20 %** |
| Index storage | 39 MB | 73 MB | **+34 MB (+87 %)** |
| Extra network round trips | — | **0** | (the 24-query bill budget in AGENTS.md is unaffected) |

### What is *not* proven

The benchmark has 18 queries and exercised **16 of the 41 new indexes**. The other 25 are justified by queries found in the code but were not measured (listed in `results/verification-results.md`). They are mostly small-table or rarely used ones. **Recommendation:** deploy all, then after a week on the real database run
`SELECT indexrelname FROM pg_stat_user_indexes WHERE idx_scan = 0` and drop any that stay unused (`001_indexes_down.sql` lists the names). (PGlite does not track `idx_scan`, which is why this could not be checked here.)

## 5. Tests run

| Test | Result |
|---|---|
| T01 data fingerprint after Phase 1 / Phase 2 / rollback | **PASS** (unchanged) |
| T02 business invariants (vouchers balance, stock ≥ 0, khata = ledger, unique bill numbers, paid bills have lines) | **PASS** (all 0 violations) |
| T03 referential integrity over all FKs, no `NOT VALID` left | **PASS** (0 problems) |
| T04 rollback restores catalog exactly | **PASS** |
| T05 constraint enforcement (6 reject, 2 accept) | **PASS** (8/8) |
| Pre-check detects deliberately dirty data | **PASS** |
| Phase 4 archive/restore lossless | **PASS** (`scripts/test-phase4.mjs`) |
| Re-applying Phase 1 twice | **PASS** (idempotent) |
| App integration suite — baseline, untouched tree | 12 failed / 392 passed / 16 skipped (**already failing before this work**) |
| App integration suite — **first** Phase 2 draft (with stock ≥ 0) | 16 failed (4 **new**) → traced and the constraint **withdrawn** (§6) |
| App integration suite — **final** Phase 1+2 | 13 failed / 407 passed / 0 skipped. The failing set is the baseline's 12 **plus exactly one**: "approves surplus counts…", the `ORDER BY`-less test of §6 finding 2 (passes with `.orderBy`). The baseline's 16 "skipped" tests ran this time and passed. (`results/app-regression-final.txt`) |
| Browser e2e through `http://localhost:5173` on a fresh local DB with Phase 1+2 applied (75 Playwright specs, Chromium) | **67 passed, 8 failed** |
| The same 8 specs on an identical stack **without** the changes | **the same 8 fail** → not caused by this work |

The 8 e2e failures (pre-existing): lower-case role text expected vs "Floor Steward (Steward)" (×2), two "Add Supplier Bill" buttons (strict-mode), missing `#page-stock`, "All outlets" dashboard title, khata total (18000 expected / 16000 received), day-closing figures mismatch, and the platform-lifecycle spec which needs `ARCHIVE_RETENTION_DAYS=0` on the server. The khata and day-closing ones were **not root-caused**; they are identical on the baseline.

## 6. Issues found *by* testing (and what was done)

| # | Finding | Action |
|---|---|---|
| 1 | `CHECK (quantity >= 0)` on `stock`/`stock_by_type` made 4 counter-sheet tests return 500: the app does `INSERT … VALUES (delta) ON CONFLICT DO UPDATE SET quantity = quantity + delta`, and PostgreSQL checks the CHECK on the proposed (possibly negative) row first. | **Withdrawn** from Phase 2 → `sql/002b_stock_nonneg_DEFERRED.sql` with the required code change. |
| 2 | One existing test ("approves surplus counts…", `counter-sheets.int.test.ts:473-478`) reads `stock_audit` with no `ORDER BY` and takes the last row; the new `idx_stock_audit_branch_product` changes physical return order. | Proven by a temporary copy with `.orderBy(createdAt, id)`: 16/16 pass. **Test file left unedited — it needs that one-line fix.** |
| 3 | Benchmark harness bugs (non-deterministic query; `pg_stat` unavailable in PGlite; a drop of the withdrawn constraint). | Fixed; the earlier "FAIL"/crash outputs were harness artefacts, kept in `results/superseded-*`. |

## 7. Remaining risks

| Risk | Level | Mitigation |
|---|---|---|
| Nothing applied to a real DB yet; production data may violate a Phase 2 rule | Medium | the pre-check lists offenders; constraints are `NOT VALID` first; never forced |
| Index write overhead ~20 % on heavy inserts; +87 % index disk on this data set | Low–Med | measure on real DB; drop unused indexes after a week |
| 25 of 41 indexes unproven by measurement | Low | see §4 |
| `ORDER BY`-less queries can change row order after indexes are added (finding 2) | Low | audit for order-dependent queries; fix the one test |
| Stock non-negativity remains **tested, not enforced** | Medium | do the deferred code change, then `002b` |
| Migrations `0017`–`0024` are uncommitted; a DB that lacks them already fails | **High (pre-existing)** | run `npm run db:migrate` first (runbook step 1) |
| 8 e2e specs and 12 integration tests already fail on the untouched code base | Info | separate from this work; listed so nobody blames the database changes |
| Drizzle `schema.ts` does not declare the indexes; `db:push` would drop them | Low | never use `db:push`; follow-up F-1 |

## 8. Recommended next steps

1. Give a reachable test DB URL → run `scripts/neon.mjs preflight`, then `phase1`, `phase2`, `verify` (reads `.env`, direct connection, never prints credentials; it applies the `_concurrent` index file statement by statement).
2. Add `.orderBy(createdAt, id)` to the one fragile test; map check violations (23514) to 422 in `sendError`.
3. Declare the indexes in `schema.ts` and generate a migration so new environments get them (F-1).
4. Later: change the stock delta-upsert, then apply `002b`.
