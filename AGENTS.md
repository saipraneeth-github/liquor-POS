# AGENTS.md — Liquor Counter POS

Read this first. It is the single source of project context for any AI assistant or new contributor.
For current work status and how to resume an unfinished task, read **`PROGRESS.md`**.

## 1. What this project is

A **point-of-sale (POS), inventory and accounting platform for liquor retail stores and bars in India**,
for single stores or multi-store syndicates. It covers counter billing (scanner POS and daily counter
sheets), cashier shifts and registers, stock and supplier purchases, bar table service with kitchen
order tickets (KOT), customer credit (khata), supplier schemes, excise quota / breakage compliance,
end-of-day closing, and double-entry accounting with Tally export.

Domain rules that drive the code:
- **MRP is tax-inclusive** and cannot be overridden at the counter; price always comes from the DB.
- GST is back-calculated from MRP per line, **after** the bill discount is allocated across lines:
  `taxable = net / (1 + rate/100)`, `tax = net - taxable`. Rate comes from the product's category.
- Every stock change is written to `stock_audit` with a reason (`SALE`, `PURCHASE`, `VOID_REVERSAL`,
  `BREAKAGE`, `COUNTER_SHEET`, ...).
- Bills are never deleted — they are **voided** (manager+, reason required); stock and credit are reversed
  and a reversing journal voucher is posted.
- A "business day" is a local calendar date (`BUSINESS_UTC_OFFSET_MINUTES`, default 330 = IST).

## 2. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22+, ESM (`"type": "module"`), TypeScript strict, `NodeNext` modules |
| HTTP | Fastify 5 (+ `@fastify/jwt`, `cors`, `helmet`) |
| DB | PostgreSQL via Drizzle ORM. `DATABASE_URL=postgresql://…` (postgres-js) **or** `pglite://<dir>` / `pglite://memory` (embedded PGlite, no install) |
| Validation | zod |
| Money math | `decimal.js` — **never use JS floats for money** |
| Auth | JWT (bcryptjs password hashes) |
| Tests | Vitest (unit + integration on in-memory PGlite), Playwright (e2e) |

Imports inside `src/` must use the `.js` extension (e.g. `import { db } from '../../db/client.js'`).

## 3. Directory map

```
src/
  app.ts                   buildApp(): plugins, route registration (/api/v1), accounting event handlers, /health, preview UI
  index.ts                 Starts the server (auto-migrates when on PGlite)
  dev-local.ts             Zero-setup runner: PGlite in ./.pglite, migrate, seed on first run, start
  db/
    schema.ts              ALL Drizzle tables + enums (single file)
    client.ts              Drizzle client; driver chosen from DATABASE_URL
    migrate.ts             Applies ./drizzle SQL migrations (runMigrations())
    seed.ts                Idempotent demo data (seedDatabase())
  lib/
    errors.ts              NotFound/Forbidden/Conflict/BusinessRule errors + sendError(reply, err)
    business-day.ts        Business-date helpers (IST by default)
    domain-events.ts       onDomainEvent / emitDomainEvent(name, payload, tx) — handlers run inside the emitting tx
  middleware/
    auth.guard.ts          requireRole(minRole) (re-reads the user every request), assertBranchAccess (async), getAccessibleBranchIds
  modules/<domain>/
    <domain>.engine.ts     PURE business logic — no DB, no I/O. Unit-tested.
    <domain>.service.ts    DB access + zod schemas; calls the engine
    <domain>.routes.ts     Fastify routes; auth, validation, HTTP status mapping
drizzle/                   Generated SQL migrations (drizzle-kit generate)
tests/
  unit/*.test.ts           Engine tests
  integration/*.int.test.ts  Real app + real SQL on in-memory PGlite via setupIntegration() (tests/integration/helpers.ts)
  e2e/*.spec.ts            Playwright journeys through preview.html (fresh PGlite DB per run)
preview.html               Single-file web UI (served at / and /preview)
```

Modules: `auth`, `users`, `branches`, `syndicates`, `products`, `billing`, `stock` (engine only),
`inventory`, `closing`, `tables`, `kot`, `terminals`, `shifts`, `counters`, `customers`, `schemes`,
`compliance`, `accounting`, `expenses`.

### Architecture rules
- Keep the **engine / service / routes** split. New business rules go in an `*.engine.ts` as pure
  functions with unit tests; services orchestrate DB work inside `db.transaction(...)`; routes stay thin.
- Cross-module side effects go through **domain events** (`bill.paid`, `bill.voided`,
  `supplierInvoice.approved`, `credit.repayment`, `expense.recorded`), not direct imports. Accounting
  (`modules/accounting/posting.service.ts`) subscribes and posts balanced vouchers in the same transaction;
  a failing handler rolls the business operation back.

## 4. Data model (src/db/schema.ts)

- Tenancy: `syndicates` → `branches` (optional `parentBranchId`) → `users` (role `owner | manager | cashier | steward`)
- Catalog: `categories` (GST `taxRate`) → `products` (barcode, sku, `mrp`, `costPrice`, `packQuantity`, `exciseCode`); `price_audit`
- Stock: `stock` (unique per branch+product) + `stock_audit`; `breakage_logs`; `excise_quotas`
- Sales: `bills` (`OPEN | PAID | VOIDED`; payment `CASH | CARD | UPI | CREDIT`; `customerId`, `shiftSessionId`, unique `clientRef`) → `bill_items`; `bill_counters` (per branch/year sequence)
- Registers: `terminals` → `shift_sessions` (one OPEN per cashier and per terminal, enforced by partial unique indexes)
- Counter-sheet sales: `daily_counter_sheets` (`DRAFT → POSTED`) → `daily_counter_sheet_lines` (Sold = Opening + Inward − Closing)
- Closing: `daily_closings` (cash/card/upi/credit split, discrepancy)
- Purchases: `supplier_invoices` (`DRAFT → REVIEWED → APPROVED | REJECTED`, unique per branch+supplier+number) → `supplier_invoice_items`
- Khata: `customers` (`creditLimit`, `currentCredit`) → `credit_transactions` (`PURCHASE | REPAYMENT | ADJUSTMENT`, `balanceAfter`, unique `clientRef`)
- Schemes: `schemes` → `scheme_purchases`, `scheme_slabs`
- Bar: `tables` → `table_sessions` → `kot_orders` (KITCHEN | BAR) → `kot_items`
- Accounting: `account_ledgers` (system codes CASH, BANK, SUNDRY_DEBTORS, SALES, OUTPUT_GST, …) → `journal_vouchers` (unique per source) → `journal_lines`; `expenses`
- Syndicate billing: `consolidated_invoices`; page permissions: `user_page_permissions`

## 5. Auth & RBAC

Role rank: `steward(1) < cashier(2) < manager(3) < owner(4)`. `requireRole('x')` allows that role and above,
and re-reads the user from the DB on every request (deactivation/demotion takes effect immediately).

Tenancy (JWT carries `sub, email, role, branchId, syndicateId`):
- platform owner = owner with `branchId` NULL and `syndicateId` NULL → all branches
- syndicate owner = owner with `syndicateId` → only branches whose `syndicate_id` matches
- everyone else → only their own `branchId`

`await assertBranchAccess(user, branchId, reply)` (async; sends 403) — **call it in every route that touches
branch-scoped data, and always `await` it** (a missing await silently disables the check). Also:
`canAccessBranch`, `getAccessibleBranchIds(user) → string[] | 'ALL'`, `isPlatformOwner`, `getOwnedSyndicateId`.
Page matrix: `requirePage('pos'|'inventory'|…, minRole?)` in `modules/auth/page-guard.ts` (owners bypass).

Login: `POST /api/v1/auth/login {email, password}` → `{ token }`. Send as `Authorization: Bearer <token>`.

## 6. API (all under `/api/v1`; read the module's `*.routes.ts` for bodies)

| Area | Endpoints | Min role |
|---|---|---|
| Auth / users | `POST /auth/login` (public) · `GET /me` · `GET/POST/PATCH /users[/:id]` · `GET/PUT /users/:id/pages` | users: manager |
| Branches / syndicates | `GET /branches` (steward) · `POST/PATCH /branches[/:id]` · `GET/POST/PATCH /syndicates[/:id]` · `GET/POST /syndicates/:id/branches[/:branchId]` · `GET/POST /syndicates/:id/consolidated-invoices` | owner (scoped) |
| Products | `GET /products` (steward+; `costPrice` omitted for stewards) · `GET /products/barcode/:barcode` (cashier) · `POST /products` · `PATCH /products/:id/mrp` (manager) | |
| Billing | `POST /bills` (201; 200 on `clientRef` replay) · `GET /bills?branchId=&date=&status=&limit=&offset=` · `GET /bills/:id` (cashier) · `POST /bills/:id/void` (manager) | |
| Registers | `GET/POST /terminals/:branchId` · `PATCH /terminals/:id` (manager) · `POST /shifts/open` · `GET /shifts/current` · `POST /shifts/:id/close` (cashier) · `GET /shifts` (manager) | |
| Counter sheets | `POST /counter-sheets/:branchId` · `GET /counter-sheets/:branchId?date=` · `GET /counter-sheets/sheet/:id` · `PUT /counter-sheets/sheet/:id/lines` (cashier) · `POST /counter-sheets/sheet/:id/post` (manager) | |
| Closing | `POST/GET /closing` | manager |
| Inventory | `POST /inventory/invoices/parse` · `POST /inventory/invoices/approve` · `GET /inventory/indent/:branchId` (manager) · `GET /inventory/stock/:branchId` (cashier) | |
| Supplier invoices | `POST /invoices/:branchId/upload` (multipart) · `POST /invoices/:branchId` · `GET /invoices/:branchId` · `GET /invoices/detail/:id` · `GET /invoices/detail/:id/file` · `PUT /invoices/detail/:id` (cashier) · `POST /invoices/detail/:id/review` · `POST /invoices/detail/:id/approve` · `POST /invoices/detail/:id/reject` (manager) | |
| Khata | `GET/POST /customers/:branchId` · `GET /customers/:id/statement` · `POST /customers/:id/repayments` (cashier; credit fields manager) · `PATCH /customers/:id` · `GET /customers/:branchId/outstanding` (manager) | |
| Schemes | `GET/POST /schemes/:branchId` · `GET /schemes/:branchId/alerts` · `POST /schemes/:schemeId/purchase` · `GET/POST /schemes/:schemeId/slabs` · `GET /schemes/:schemeId/payout` | manager |
| Compliance | `GET/POST /compliance/quotas/:branchId` · `GET /compliance/lifting/:branchId` · `POST /compliance/breakage/:branchId` (cashier) · `GET /compliance/breakage/:branchId` · `GET /compliance/stock-audit/:branchId` (manager) | |
| Accounting | `GET/POST /accounting/ledgers/:branchId` · `GET /accounting/ledgers/:branchId/:ledgerId/entries` · `GET /accounting/vouchers/:branchId` · `POST /accounting/journal/:branchId` · `GET /accounting/trial-balance/:branchId` · `GET /accounting/profit-loss/:branchId` · `GET /accounting/balance-sheet/:branchId` · `GET /accounting/tally-export/:branchId` (XML) · `GET/POST /expenses/:branchId` | manager |
| Bar | `GET /tables/:branchId` (steward, branch-scoped) · `POST /tables/:tableId/open|close` (cashier) · `POST /tables/:branchId` (manager) · `POST /kot` · `PATCH /kot/:kotOrderId/items/:itemId` · `GET /kot/session/:sessionId` (steward) · `GET /kot/session/:sessionId/bill` (cashier) | |

Status codes: 400 validation · 401 no/invalid token or inactive user · 403 role/branch · 404 · 409 duplicate/state conflict · 422 business rule · 500 unexpected DB error (logged, message hidden).
Non-API: `GET /health`, `GET /` (UI if `Accept: text/html`), `GET /preview`.

## 7. Running locally

Zero setup (embedded PGlite, data in `./.pglite`):
```bash
npm install
npm run dev:local             # migrates, seeds on first run, serves http://localhost:3001
```
Against a real PostgreSQL:
```bash
cp .env.example .env          # set DATABASE_URL=postgresql://…, JWT_SECRET (32+ chars)
npm run db:migrate && npm run db:seed && npm run dev
```
Seed logins (password `Password@123`): `owner@liquor.com` (syndicate owner — picks a branch),
`manager@liquor.com`, `cashier@liquor.com`, `steward@liquor.com`.

Tests: `npm test` (all Vitest), `npm run test:unit`, `npm run test:integration`,
`npm run test:e2e` (Playwright boots its own fresh PGlite DB in `./.pglite-e2e`; first time run `npx playwright install chromium`).
Schema change: edit `schema.ts` → `npm run db:generate` (needs any `DATABASE_URL` set) → commit the new `drizzle/` files.

## 8. Known gaps / gotchas

- Stock changes must use guarded atomic SQL (`quantity = quantity - n WHERE quantity >= n`, or upsert with
  `quantity + n`) inside the transaction; bill numbers come from `bill_counters` (upsert … RETURNING).
- Integration tests run on PGlite, which serialises transactions — row-lock behaviour (`FOR UPDATE`) is only
  truly exercised on real Postgres.
- Product MRP is global (not per branch); changes are recorded in `price_audit`.
- Purchases use periodic inventory (debited to PURCHASES; no automatic closing-stock entry).
- Slab payouts use the "best slab reached" rule (non-cumulative) and assume `scheme_purchases.qty` is in cases.
- Closing selects bills by creation date; voiding a bill from an already-closed day is not reflected in that closing.
- Windows PowerShell 5.1 `Get-Content` mis-displays UTF-8 (box-drawing comments look like `â”€`); the files are fine — use `-Encoding utf8`.
- `.agents/` and `README.md` describe generic AI tooling, not this app; ignore them for project context.

## 9. Conventions

- Money: `numeric(12,2)` in DB, decimal strings in TS, `decimal.js` for arithmetic, `.toFixed(2)` on output;
  zod money regexes cap integer digits so oversized values fail validation (400) instead of overflowing the column.
- Validate params and bodies with zod `safeParse`; map service errors with `sendError`.
- Multi-table writes go in `db.transaction`; every stock change gets a `stock_audit` row.
- Idempotency for client retries: `clientRef` on bills and repayments.
- Commit style: conventional commits (`feat(scope): ...`, `test(e2e): ...`, `chore(db): ...`).
