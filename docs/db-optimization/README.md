# Database optimisation — Liquor Counter POS

Audit and safe optimisation of the PostgreSQL schema (64 tables, 25 migrations). Produced by a read-only review of
`src/db/schema.ts`, `drizzle/`, and every query in `src/`, then **verified on a throwaway in-memory PGlite database**.
Nothing in this package was run against the production (Neon) database and no application file was modified.

## Read in this order

| # | Document | Brief step |
|---|---|---|
| 01 | [Schema audit](01-schema-audit.md) | 1 — audit tables, columns, types, keys, indexes; list issues |
| 02 | [Redundancy analysis](02-redundancy-analysis.md) | 2 — duplicated / unused / redundant items and impact of removal |
| 03 | [Proposed changes](03-proposed-changes.md) | 3 — normalisation & clean-up, with DDL (`sql/`) |
| 04 | [Referential integrity](04-referential-integrity.md) | 4 — relationships, constraints, cascades after the change |
| 05 | [Application impact](05-application-impact.md) | 5 — which features use what; code changes flagged |
| 06 | [Test plan](06-test-plan.md) | 6 — data, query, constraint, performance, rollback tests (scripts) |
| 07 | [Final report](07-final-report.md) | 7 — before/after, removed redundancies, gains, residual risk |
| 08 | [Deployment runbook](08-deployment-runbook.md) | safe order, gates, rollback |

## One-paragraph result

The schema is well-normalised and has no dead tables or duplicate indexes. Its real weaknesses are **missing indexes** (103 of 133 foreign
keys unindexed; no date-range index on `bills`, `stock_audit`, `journal_*`) and **no database-level constraints** (0 CHECKs).
The package adds indexes and guard-rails only, loses no data, and is reversible at every step.

## Files

```
sql/
  001_indexes_up.sql / _down.sql           Phase 1   (+ *_concurrent.sql: the production variants)
  002_integrity_precheck.sql               Phase 2   read-only, must return 0 rows
  002_integrity_up.sql / _down.sql         Phase 2
  004_retention_archive_up.sql / _down.sql Phase 4   optional
  tests/t01..t05_*.sql                     test scripts
scripts/
  lib.mjs                  builds the scratch DB from ./drizzle (never reads DATABASE_URL)
  audit-catalog.mjs        catalog audit + schema/migration drift check
  fk-coverage.mjs          FK index coverage before/after
  query-usage.mjs          which table.column the code filters / joins / sorts on
  usage-census.mjs         which tables/columns the code references
  counts.mjs               headline inventory numbers
  verify.mjs               end-to-end verification + benchmark  -> results/
  test-phase4.mjs          archive no-data-loss test
  app-regression.mjs       project integration suite with the phases applied
  make-migration.mjs       builds drizzle/0025_db_optimization.sql from the SQL files + registers it in the journal
  test-migration-0025.mjs  tests 0025 with the real Drizzle migrator (populated / violating / empty databases)
  neon.mjs                 runs preflight / phase1 / phase2 / verify / rollback against the database in .env
results/                   generated evidence (verification-results.md/json, app-regression.txt)
```

## Applying with the normal workflow: migration 0025

`drizzle/0025_db_optimization.sql` (journal entry idx 25) bundles Phase 1 + Phase 2, so **`npm run db:migrate` applies it** like any other migration.
It is generated from the SQL files here (`scripts/make-migration.mjs`) and tested with the real Drizzle migrator
(`scripts/test-migration-0025.mjs`): populated database at 0024 -> only 0025 applied, data unchanged, re-run is a no-op;
a row violating a rule -> the whole migration rolls back; empty database -> all 26 apply.
Trade-offs: plain `CREATE INDEX` (the migrator uses one transaction, so no `CONCURRENTLY`: brief write locks while each index builds),
no separate pre-check (run `neon.mjs preflight` first), no automatic down step (use `002_integrity_down.sql` + `001_indexes_down.sql`
or the restore branch). Suitable for test/staging; for a busy production database prefer the `_concurrent` files with `psql`.

## Reproduce

```bash
node docs/db-optimization/scripts/audit-catalog.mjs
node docs/db-optimization/scripts/verify.mjs 40000      # minutes; scale = bills per branch
node docs/db-optimization/scripts/test-phase4.mjs
node docs/db-optimization/scripts/app-regression.mjs    # temporarily adds a migration, always restores the journal
```

## Not done (needs your decision)

Nothing was applied to any real database, and `schema.ts` / `drizzle/` were not changed. Declaring the indexes in `schema.ts`
(follow-up F-1) is the one change that would touch your working tree; see `05-application-impact.md` §5.
