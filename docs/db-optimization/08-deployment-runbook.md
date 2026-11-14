# 08 — Safe deployment runbook (production-like)

> Order matters. Each phase is independent, reversible, and has a go/no-go gate. **Do not run any of this against production until
> every gate in §1 is green on a restored staging copy.** Nothing here was run against the real database by the author.

## 0. Principles

1. **Additive first, restrictive later, destructive never.** Phase 1 adds indexes, Phase 2 adds rules, Phase 4 only *moves* rows. No phase drops a column or table.
2. **Online.** Indexes are built `CONCURRENTLY` (no write lock); constraints are added `NOT VALID` then `VALIDATE`d (no long lock).
3. **Off-peak, one phase per window, observe 24 h between phases.**
4. **Direct connection.** On Neon use the *direct* (non-pooled) connection string for DDL; `CONCURRENTLY` cannot run through a transaction-pooling pooler or inside a transaction (so **not** through `npm run db:migrate`, which wraps each file in a transaction).
5. Each phase: backup → pre-check → apply → post-check → keep rollback ready.

## 1. Pre-flight (once)

| # | Step | Command / action | Gate |
|---|---|---|---|
| 1 | **Bring the schema current.** Migrations `0017`–`0024` are uncommitted locally; make sure production has them (F-09). | `npm run db:migrate` (with the production `DATABASE_URL`) — *this is the app's normal procedure, independent of this package* | `SELECT count(*) FROM drizzle.__drizzle_migrations` = 25 |
| 2 | **Backup.** Neon: create a branch / point-in-time restore point. Elsewhere: `pg_dump -Fc "$DIRECT_URL" -f pre_dbopt_$(date +%F).dump`. | verify the dump restores (`pg_restore --list`) | restorable |
| 3 | **Restore the backup to staging** and run everything below there first. | | staging ready |
| 4 | Record baselines: `psql -f sql/tests/t01_fingerprint.sql > fp_before.txt`; `t04_catalog_snapshot.sql > cat_before.txt`; `t02_business_invariants.sql` (all zero) | | files saved |
| 5 | Note timings of 3–5 slow screens (Bill list, Trial balance, Stock audit, KOT) for before/after | | noted |
| 6 | Free disk: Phase 1 adds roughly **0.8–1× the current table size** in index space (measured ratio in `results/verification-results.md`) | `SELECT pg_size_pretty(pg_database_size(current_database()))` | ≥ 2× that free |

## 1a. Shortcut for test / staging: migration 0025

`npm run db:migrate` applies `drizzle/0025_db_optimization.sql` (Phase 1 + Phase 2 in one transaction; all-or-nothing). It uses plain
`CREATE INDEX` and has no pre-check, so on production keep the phased `CONCURRENTLY` route below. Take the restore point first, and run
`node docs/db-optimization/scripts/neon.mjs preflight` (read-only) before migrating.

## 2. Phase 1 — indexes (low risk)

```bash
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f docs/db-optimization/sql/001_indexes_up_concurrent.sql
```

**Post-check**

```sql
-- no half-built indexes (a failed CONCURRENTLY build leaves an INVALID one that costs writes and helps nobody)
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;          -- must be empty
```
If any appear: `DROP INDEX CONCURRENTLY <name>;` then re-run the file (it is idempotent: `IF NOT EXISTS`).
Then `ANALYZE;`, re-run `t01` (diff with `fp_before.txt` → identical), `t03` (empty), and re-time the screens from step 5.

**Rollback:** `psql "$DIRECT_URL" -f docs/db-optimization/sql/001_indexes_down_concurrent.sql`. No data impact.
**Abort signals:** replication lag / write latency up > 25 %, disk > 85 %.

## 3. Phase 2 — constraints (medium risk: first one that can *reject* writes)

1. Run `002_integrity_precheck.sql` on **production (read-only)**. **Every query must return zero rows.** Any row = bad existing data:
   fix it deliberately (with the business owner), or delete *that one constraint* from `002_integrity_up.sql`. Do not force.
2. Run the app integration suite against the phase applied (see `06-test-plan.md` §4). Known: one test needs an `.orderBy` (05 §1.0).
3. Apply Step A of `002_integrity_up.sql` (all `NOT VALID`, instant). From this moment bad **new** writes are rejected.
4. Watch application logs for **500s with SQLSTATE 23514/23503** for one trading day. (Recommended: ship follow-up F-2 first so these show as clear 422s.)
5. Apply Step B (`VALIDATE CONSTRAINT`, scans old rows, does not block normal reads/writes).
6. `t03` empty, `t02` all zero, `t01` identical.

**Rollback:** `002_integrity_down.sql` (`DROP CONSTRAINT`). No data impact.
**Stock non-negativity is NOT enforced** by this phase (withdrawn: it breaks counter-sheet posting — see `03` and `sql/002b_stock_nonneg_DEFERRED.sql`).

## 4. Phase 4 — archive old operational rows (optional; separate window)

1. Backup again. Run `004_retention_archive_up.sql` (one atomic move per table).
2. Check counts: `SELECT (SELECT count(*) FROM email_outbox) + (SELECT count(*) FROM email_outbox_archive)` equals the pre-run live count.
3. **Rollback:** `004_retention_archive_down.sql`.

## 5. Follow-ups after the phases are stable

F-1 (declare the indexes in `schema.ts` + generate a migration so fresh databases get them) · F-2 (23514 → 422) — see `05-application-impact.md` §5.

## 6. Decision table: what to do if…

| Symptom | Action |
|---|---|
| `CREATE INDEX CONCURRENTLY` errors "cannot run inside a transaction block" | you used the migrator or a pooler; use `psql` on the direct URL |
| An index shows `indisvalid = false` | `DROP INDEX CONCURRENTLY` it and re-run Phase 1 |
| Pre-check returns rows | stop; fix data or omit that constraint; never `VALIDATE` over bad data |
| Write latency noticeably higher after Phase 1 | check `pg_stat_user_indexes` for new indexes with `idx_scan = 0` after a week and drop those (the verification run lists the ones its benchmark never exercised) |
| Any unexpected behaviour | run the matching `*_down.sql`; if still unsure, restore the pre-flight backup |

## 7. Sign-off checklist

- [ ] Backup taken and restore proven
- [ ] Staging run: T01 identical · T02 zero · T03 empty · T05 all ok · rollback restores catalog hash
- [ ] Integration suite: no new failures vs baseline
- [ ] Phase 1 applied · no invalid indexes · screens re-timed
- [ ] Phase 2 pre-check zero · constraints validated · no 23514 in logs for a trading day
- [ ] Follow-ups F-1 / F-2 scheduled
