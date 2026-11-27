# AGENTS.md — Liquor Counter POS

Liquor Counter is a POS, inventory, bar service and accounting app for Indian liquor retailers and multi-outlet businesses.

- [README](README.md) — repository map, local setup, demo accounts and test commands.
- [PROGRESS.md](PROGRESS.md) — current state, verification and open work. Update it at session end.
- [Tests](tests/README.md), [Runbook](docs/RUNBOOK.md) and [Integrations](docs/INTEGRATIONS.md) — fixtures, operations and external services.
- Use Git, `drizzle/` and the QA reports for history. Use current source and tests for exact API and schema behavior.

## Code and verification

- Node.js 22+, strict TypeScript ESM, Fastify, Drizzle with PostgreSQL or PGlite, Zod, and React/Vite. Backend relative imports use `.js`.
- Keep `src/modules/<domain>/` split into pure, unit-tested engines, transactional services, and thin routes. Routes validate with Zod and map errors with `sendError`. Read `*.routes.ts` for the `/api/v1` contract, `src/db/schema.ts` for the data model, and `src/app.ts` for registration.
- Send cross-module side effects through domain events. Accounting handlers post balanced vouchers inside the originating transaction. A failure rolls back the operation. Use `tx` for queries inside transactions.
- Ship a forward migration in `drizzle/` with every schema change and mirror SQL constraints and indexes in `schema.ts`. Migrate real PostgreSQL before restarting. Use typed Drizzle predicates for JS dates in PostgreSQL queries.
- Use `npm run dev:local` for embedded PGlite. Run `npm run build:frontend` before `npm run test:e2e`. Playwright can reuse port 3001, so verify the listener and run against an isolated, freshly seeded database. PGlite serializes transactions. Use real PostgreSQL when validating row-lock behavior.
- Test pure rules in `tests/unit`, DB/API behavior in `tests/integration`, and user journeys in `tests/e2e`. Keep real supplier invoices and bank statements in ignored `tests/fixtures/local/`. Use Conventional Commits when committing.

## Money, inventory and books

- Keep money in decimal strings and calculate with `decimal.js`. MRP is tax-inclusive and comes from the database. Allocate bill discounts to lines before calculating category tax from each net amount. The default cashier discount cap is 5%, enforced in paise unless the user holds `discount.unlimited`.
- The platform master catalog defines product identity and carries no prices. Businesses own their mapped or custom products. For Walk-in, use the branch override then business MRP. For another sale type, use its branch override then its business type price. A missing type price blocks billing and transfers into that counter. Price edits are audited. Keep mapped identity fields tied to the master.
- `stock` is the outlet total. `stock_by_type` holds explicit non-default quantities. Walk-in is the remainder. Use guarded atomic writes or the existing stock-delta helper, and audit every movement. Default-counter deductions must preserve other counters' allocations. Maintain transactional bill-number counters and `clientRef` retry behavior.
- Counter sheets are per branch, business day and sale type. Sold = opening + inward + net transfers − closing. Keep physically counted closings when later bills arrive and audit opening edits. Post only unbilled sales after excluding POS bills and breakage. Reverse the voucher on unpost.
- Void paid bills with authorization and a reason, reversing stock, credit and accounting. Reverse approved supplier invoices, including stock, schemes and vouchers. Supplier bills record purchase cost, update branch cost and leave selling prices to Products → Pricing. Periodic inventory applies and supplier invoices post no input GST.
- Business dates use `BUSINESS_UTC_OFFSET_MINUTES` (default IST). Use shared cash-movement and closed-day helpers for drawer totals and date guards. Day closing requires all shifts closed.
- Bank reconciliation matches against BANK-ledger entries. Matching suggests before a person confirms. Posting a missing line creates an idempotent voucher. An ignore requires a reason and keeps the line. Rules are account-scoped and must preserve book matches and manual exemptions. Import validates the balance chain, audits an explicit override, deduplicates overlapping lines and stores no source file. Reconciliation checks both unresolved entries and the balance difference.
- Keep bill prechecks batched and measure new database round trips on billing or posting paths with `DB_LOG_QUERIES=1`.

## Access and UI

- Role order is steward < cashier < manager < office admin < owner. Recheck active users and effective permissions on each request. Always await `assertBranchAccess` on branch-scoped routes. A business owner sees their own outlets. Platform owners use the Platform console and its separately guarded endpoints. Other staff are branch-scoped.
- Protect APIs with server-side role and action checks. The page matrix controls navigation and route visibility. Respect tenant scope, cost redaction and the invoice cost gate. Apply sale-type restrictions to billing and counter sheets. Owners and office admins retain their role defaults. Use the existing permission services and request-local permission snapshot.
- Cashiers may create expenses through the narrowly scoped dashboard/API exception. Preserve existing list and reversal guards, branch checks and closed-day rules.
- React in `frontend/` is the served UI. Keep offline bill retries idempotent and scoped to the originating user. Use `frontend/src/auth/navigation.ts` for menu and landing rules, and share `ExpenseModal.tsx` between dashboard and Accounting.
- Write short, familiar staff labels in English, Hindi and Telugu. Keep collect/change amounts clear and make keyboard, touch and error recovery flows usable. Check narrow phones and desktop. The palette lives in `frontend/src/index.css` (Tailwind `purple-*` maps to brand green). Keep dashboard styles scoped under `.lc`.
