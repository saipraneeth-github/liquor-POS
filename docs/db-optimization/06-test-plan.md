# 06 — Test plan

> Step 6. Every test below exists as a runnable script. `scripts/verify.mjs` runs all of them end-to-end on a scratch database;
> the same SQL files are used unchanged on a restored staging copy of production.

## 1. Where tests run

| Environment | Use | Data |
|---|---|---|
| Scratch PGlite (in-memory) | `node docs/db-optimization/scripts/verify.mjs [billsPerBranch]` — fully automatic, destroys itself | synthetic: 3 branches, bills → items → stock audit → journal → KOT → invoices |
| **Staging = restored production backup** | run the `sql/tests/*.sql` and the pre-check by hand with `psql` | real data — the only place the pre-check means something |
| Production | read-only pre-check + T01/T02/T03 only; **never T05** (it writes, inside rolled-back blocks) | real |

## 2. Test catalogue

| ID | Category | Script | Pass criterion | When |
|---|---|---|---|---|
| T01 | **Data integrity** — nothing lost / changed | `sql/tests/t01_fingerprint.sql` | output identical before and after each phase (row count + md5 of all rows, 11 key tables) | before/after P1, P2, P4, rollback |
| T02 | **Query results / business invariants** | `sql/tests/t02_business_invariants.sql` | every `violations = 0`, before **and** after | before/after every phase |
| T03 | **Referential integrity** (generic over all 133 FKs) + no `NOT VALID` left | `sql/tests/t03_referential_integrity.sql` | zero rows | after P1, P2 |
| T04 | **Catalog snapshot** (hash of all indexes, constraints, columns) | `sql/tests/t04_catalog_snapshot.sql` | after DOWN scripts, hashes equal the pre-change hashes | rollback test |
| T05 | **Constraint enforcement** (8 probes: 6 must be rejected, 2 must be accepted) | `sql/tests/t05_constraint_enforcement.sql` | every `ok = true` | after P2 (staging only) |
| PRE | **Pre-check** — existing data already obeys the new rules | `sql/002_integrity_precheck.sql` | zero rows | before P2 on real data |
| PRE-neg | Pre-check is not vacuous | `verify.mjs` plants a negative stock row and asserts the pre-check reports it | detected | scratch |
| B01–B18 | **Performance** — 18 representative queries from the code, `EXPLAIN (ANALYZE, BUFFERS)`, median of 7 | `verify.mjs` (`QUERIES` array) | after ≤ before, and the plan uses the new index | before/after P1 |
| W01 | **Write overhead** — 5,000 bills + lines + stock-audit rows inserted and rolled back | `verify.mjs` `writeBench` | overhead reported; accept ≤ ~25 % | before/after P1 |
| S01 | **Storage** — table vs index bytes | `verify.mjs` `sizes` | reported | before/after P1 |
| RB1 | **Rollback — Phase 1+2** | `verify.mjs` applies `002_down`, `001_down`, then T04 + T01 | catalog hash == original, fingerprint == original | scratch + staging |
| RB2 | **Rollback — Phase 4** | `scripts/test-phase4.mjs` | live+archive counts and hash equal before/after UP and after DOWN; PENDING/FAILED print jobs untouched | scratch |
| RP1 | **Re-applicability** | `verify.mjs` applies `001_up` twice | no error (`IF NOT EXISTS`) | scratch |
| APP1 | **Application regression** | `npm run test:integration` with the phases applied (see §4) | no *new* failure compared with the baseline run | scratch, before shipping |

## 3. Running them

```bash
# everything, automatic (≈ minutes; scale = bills per branch)
node docs/db-optimization/scripts/verify.mjs 40000
node docs/db-optimization/scripts/test-phase4.mjs

# staging copy, one test by hand (psql)
psql "$STAGING_URL" -f docs/db-optimization/sql/tests/t01_fingerprint.sql > /tmp/fp_before.txt
psql "$STAGING_URL" -f docs/db-optimization/sql/001_indexes_up_concurrent.sql
psql "$STAGING_URL" -f docs/db-optimization/sql/tests/t01_fingerprint.sql > /tmp/fp_after.txt
diff /tmp/fp_before.txt /tmp/fp_after.txt && echo "DATA UNCHANGED"
```

## 4. Application regression (APP1)

The project's own suite (`tests/integration/*.int.test.ts`) boots the real app on in-memory PGlite built from `./drizzle`.
To run it with the proposed phases, the SQL is applied as an extra migration for the duration of the run and removed afterwards;
the **baseline must be run first on the untouched tree** because the working tree already contains failing tests unrelated to this work.
The comparison is "same set of failures before and after", recorded in `07-final-report.md`.

## 5. Query-result equivalence (before == after)

Indexes cannot change a result set, but the plan test proves it explicitly for the eighteen benchmark queries: `verify.mjs`
runs each benchmark query's *result hash* before and after Phase 1 and asserts equality (see `resultHashesEqual` in the JSON output).

## 6. Rollback procedure (also in the runbook)

| Phase | Rollback | Data risk |
|---|---|---|
| 1 | `sql/001_indexes_down_concurrent.sql` — `DROP INDEX CONCURRENTLY` | none (indexes hold no unique data) |
| 2 | `sql/002_integrity_down.sql` — `DROP CONSTRAINT` | none |
| 4 | `sql/004_retention_archive_down.sql` — moves rows back, drops archive tables only if empty | none |
| any | Restore the pre-flight backup (`pg_dump` / Neon branch) | last resort |
