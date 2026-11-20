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
  app.ts                   buildApp(): plugins, route registration (/api/v1), accounting event handlers, /health, serves the built React app at /
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
  e2e/*.spec.ts            Playwright journeys through the React app (fresh PGlite DB per run; build the frontend first)
frontend/                  The React web app (Vite). Built into dist/frontend and served by the API at /
```

Modules: `saletypes`, `auth`, `users`, `branches`, `syndicates`, `products`, `billing`, `stock` (engine only),
`inventory`, `closing`, `tables`, `kot`, `terminals`, `shifts`, `counters`, `customers`, `schemes`,
`compliance`, `accounting`, `expenses`, `bank` (statement upload + reconciliation).

### Architecture rules
- Keep the **engine / service / routes** split. New business rules go in an `*.engine.ts` as pure
  functions with unit tests; services orchestrate DB work inside `db.transaction(...)`; routes stay thin.
- Cross-module side effects go through **domain events** (`bill.paid`, `bill.voided`,
  `supplierInvoice.approved`, `supplierInvoice.reversed`, `credit.repayment`, `expense.recorded`), not direct imports. Accounting
  (`modules/accounting/posting.service.ts`) subscribes and posts balanced vouchers in the same transaction;
  a failing handler rolls the business operation back.

## 4. Data model (src/db/schema.ts)

- Tenancy: `syndicates` → `branches` (optional `parentBranchId`) → `users` (role `owner | manager | cashier | steward`)
- Catalog (three layers, see "Master catalog, mapping and prices" below): platform `categories` + `master_products` (no prices) → the business's `products` (`syndicate_id` NOT NULL, `master_product_id` = the mapping; `mrp` = business-wide price, 0.00 = not priced) → `branch_product_prices` (a branch's own price); `price_audit`
- Stock: `stock` (unique per branch+product) + `stock_audit`; `breakage_logs`; `excise_quotas`
- Sales: `bills` (`OPEN | PAID | VOIDED`; payment `CASH | CARD | UPI | CREDIT`; `customerId`, `shiftSessionId`, unique `clientRef`) → `bill_items`; `bill_counters` (per branch/year sequence)
- Registers: `terminals` → `shift_sessions` (one OPEN per cashier and per terminal, enforced by partial unique indexes)
- Counter-sheet sales: `daily_counter_sheets` (`DRAFT → POSTED`; one per branch, day **and sale type**) → `daily_counter_sheet_lines` (Sold = Opening + Inward + Transfer − Closing)
- Sale types: `sale_types` (per business: `WALK_IN` = default, `JANATA`, ...; `branch_sale_types` switches them per shop) · `product_prices` (price per product per non-default type; no row = not sold there) · `stock_by_type` (explicit counter of a non-default type). The default type is priced by `products.mrp` and its stock is `stock.quantity − Σ stock_by_type`. Rows that reference a sale type (`bills`, `stock_audit`, `price_audit`, `daily_counter_sheets`) store NULL for the default type.
- Closing: `daily_closings` (cash/card/upi/credit split, discrepancy)
- Purchases: `supplier_invoices` (`DRAFT → REVIEWED → APPROVED | REJECTED | REVERSED`, unique per branch+supplier+number) → `supplier_invoice_items`
- Khata: `customers` (`creditLimit`, `currentCredit`) → `credit_transactions` (`PURCHASE | REPAYMENT | ADJUSTMENT`, `balanceAfter`, unique `clientRef`)
- Schemes: `schemes` → `scheme_purchases`, `scheme_slabs`
- Bar: `tables` → `table_sessions` → `kot_orders` (KITCHEN | BAR) → `kot_items`
- Accounting: `account_ledgers` (system codes CASH, BANK, SUNDRY_DEBTORS, SALES, OUTPUT_GST, …) → `journal_vouchers` (unique per source) → `journal_lines`; `expenses`
- Syndicate billing: `consolidated_invoices`; page permissions: `user_page_permissions`
- Bank reconciliation: `bank_accounts` (`scope` BRANCH | SYNDICATE; only the last 4 digits are stored) → `bank_statements` (unique per account + file hash) → `bank_statement_lines` (unique per account + transaction `hash`, status `UNMATCHED | SUGGESTED | MATCHED | IGNORED`); `bank_line_matches` links a line to the BANK-ledger `journal_lines` it accounts for (a journal line is matched at most once)

## 5. Auth & RBAC

Role rank: `steward(10) < cashier(20) < manager(30) < office_admin(35) < owner(40)` (integers; `roleRank()` throws on an unknown role; frontend keeps its own copies). `requireRole('x')` allows that role and above,
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
| Products | `GET /products?branchId=` (steward+; `costPrice` omitted for stewards; `mrp` = what that branch charges, plus `tenantMrp`, `branchPrice`, `needsPrice`) · `GET /products/barcode/:barcode` (cashier) · `POST /products` (`costPrice` ignored without `cost.view`; `masterProductId` takes identity from the master) · `PATCH /products/:id` (name/barcode/...; **strict: `mrp`/`costPrice` → 400; on a mapped product brand/size/pack/sku/excise/category → 422**) · `PATCH /products/:id/mrp` (`prices.edit`, writes `price_audit`) | |
| Catalog | `GET /catalog/master[/categories]` (cashier) · `POST /catalog/master/map` (manager; ids, categories or all) · `GET /catalog/pricing` (manager) · `PUT /catalog/prices` and `PUT /catalog/branches/:branchId/prices` (`prices.edit`; rows by productId, sku or barcode; branch rows may carry `saleTypeId`, `price: null` removes) | |
| Billing | `POST /bills` (201; 200 on `clientRef` replay) · `GET /bills?branchId=&date=&status=&limit=&offset=` · `GET /bills/:id` (cashier) · `POST /bills/:id/void` (manager) | |
| Registers | `GET/POST /terminals/:branchId` · `PATCH /terminals/:id` (manager) · `POST /shifts/open` · `GET /shifts/current` · `POST /shifts/:id/close` (cashier) · `GET /shifts` (manager) | |
| Sale types | `GET /sale-types/:branchId` (steward) · `POST /sale-types/:branchId` · `PATCH /sale-types/:branchId/:id` · `PUT /sale-types/:branchId/prices` · `POST /sale-types/:branchId/transfer` (manager) · `GET /sale-types/:branchId/prices` · `GET /sale-types/:branchId/stock` (cashier) | |
| Counter sheets | `POST /counter-sheets/:branchId` (`saleTypeId?`) · `GET /counter-sheets/:branchId?date=&saleTypeId=` · `GET /counter-sheets/sheet/:id` · `PUT /counter-sheets/sheet/:id/lines` (cashier) · `POST /counter-sheets/sheet/:id/post` (manager) | |
| Closing | `POST/GET /closing` | manager |
| Inventory | `GET /inventory/indent/:branchId` (manager) · `GET /inventory/stock/:branchId` (cashier) | |
| Supplier invoices | `POST /invoices/:branchId/upload` (multipart) · `POST /invoices/:branchId` · `GET /invoices/:branchId` · `GET /invoices/detail/:id` · `GET /invoices/detail/:id/file` · `PUT /invoices/detail/:id` (cashier) · `POST /invoices/detail/:id/review` · `POST /invoices/detail/:id/approve` · `POST /invoices/detail/:id/reject` · `POST /invoices/detail/:id/reverse` (manager) | |
| Khata | `GET/POST /customers/:branchId` · `GET /customers/:id/statement` · `POST /customers/:id/repayments` (cashier; credit fields manager) · `PATCH /customers/:id` · `GET /customers/:branchId/outstanding` (manager) | |
| Schemes | `GET/POST /schemes/:branchId` · `GET /schemes/:branchId/alerts` · `POST /schemes/:schemeId/purchase` · `GET/POST /schemes/:schemeId/slabs` · `GET /schemes/:schemeId/payout` | manager |
| Compliance | `GET/POST /compliance/quotas/:branchId` · `GET /compliance/lifting/:branchId` · `POST /compliance/breakage/:branchId` (cashier) · `GET /compliance/breakage/:branchId` · `GET /compliance/stock-audit/:branchId` (manager) | |
| Accounting | `GET/POST /accounting/ledgers/:branchId` · `GET /accounting/ledgers/:branchId/:ledgerId/entries` · `GET /accounting/vouchers/:branchId` · `POST /accounting/journal/:branchId` · `GET /accounting/trial-balance/:branchId` · `GET /accounting/profit-loss/:branchId` · `GET /accounting/balance-sheet/:branchId` · `GET /accounting/tally-export/:branchId` (XML) · `GET/POST /expenses/:branchId` | manager |
| Bank reconciliation | `GET/POST /bank/accounts` · `PATCH /bank/accounts/:id` · `POST /bank/accounts/:id/statements/preview` (multipart, saves nothing) · `POST /bank/accounts/:id/statements` (multipart: import + auto-match) · `GET /bank/accounts/:id/statements` · `GET /bank/statements/:id[/lines\|/summary]` · `POST /bank/statements/:id/match\|accept-suggestions\|ignore\|apply-ignore-suggestions\|finalize` · `GET/POST /bank/accounts/:id/rules` · `PATCH/DELETE /bank/rules/:id` · `DELETE /bank/statements/:id` · `GET /bank/lines/:id/candidates` · `POST /bank/lines/:id/accept\|match\|post\|ignore\|unmatch` | manager (a SYNDICATE-scope account: owner) |
| Bar | `GET /tables/:branchId` (steward, branch-scoped) · `POST /tables/:tableId/open|close` (cashier) · `POST /tables/:branchId` (manager) · `POST /kot` · `PATCH /kot/:kotOrderId/items/:itemId` · `GET /kot/session/:sessionId` (steward) · `GET /kot/session/:sessionId/bill` (cashier) | |

Status codes: 400 validation · 401 no/invalid token or inactive user · 403 role/branch · 404 · 409 duplicate/state conflict · 422 business rule · 500 unexpected DB error (logged, message hidden).
Non-API: `GET /health`, `GET /` (the React app when it has been built, otherwise a small JSON note), and any other path falls through to the React app so its routes work on reload.

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
- Product MRP is the business-wide price (a branch can override it in `branch_product_prices`); every change is recorded in `price_audit`.
- Purchases use periodic inventory (debited to PURCHASES; no automatic closing-stock entry).
- Slab payouts use the "best slab reached" rule (non-cumulative) and assume `scheme_purchases.qty` is in cases.
- Closing selects bills by creation date; voiding a bill from an already-closed day is not reflected in that closing.
- Windows PowerShell 5.1 `Get-Content` mis-displays UTF-8 (box-drawing comments look like `â”€`); the files are fine — use `-Encoding utf8`.
- `.agents/` and `README.md` describe generic AI tooling, not this app; ignore them for project context.

### Permissions (`src/modules/permissions/`, Staff & Terminals → Access)

- **Office Admin** runs the business for the owner: above a manager, below the owner. Everything inside the business, nothing above it: the platform console, creating outlets, subscription billing and business-wide shared bank accounts stay owner-only. Only the owner creates an office admin; an office admin creates managers / cashiers / stewards; a manager creates cashiers / stewards. `ProtectedButton` and the guard use the same ranks.
- **Actions** are permissions with role defaults (owner / office admin / manager = all, cashier / steward = none) and per-user overrides in `user_permissions`: `cost.view`, `prices.edit`, `sale_types.manage`, `stock.move`, `counter.opening`, `invoices.approve` (needs `cost.view`), `bills.void`, `discount.unlimited`. Owner and office admin cannot be restricted. Use `requirePermission(key)` after `requireRole('steward')` on a route; the permission, not the rank, decides. Only users below you can be changed and nobody can grant what they do not hold (`GET/PUT /users/:id/permissions`, manager+). `/me` returns the effective `permissions`, `discountCapPct` and `saleTypeIds`.
- **Cost is a permission.** Without `cost.view` a user never gets cost fields (`stripCost`, any depth) from products, stock, breakage, and every supplier-invoice route is closed (403 `PERMISSION_DENIED`).
- **Discounts** above 5% of the bill (`DISCOUNT_CAP_PCT`) need `discount.unlimited`; checked exactly in paise in `createBill`.
- **Sale types per user** (`user_sale_types`, cashier / steward only; no rows = all): enforced in billing and every counter-sheet route; `GET /sale-types/:b` returns only the allowed ones.
- **Page access** (`user_page_permissions`) only controls the sidebar and which URLs open; the API is protected by role + permission, not by the page matrix (`requirePage` is unused).
### Sale types (Walk-in, Janata, ...) (`src/modules/saletypes/`)

- A sale type is a **price list plus its own counter**. `POST /bills` takes `saleTypeId` (omitted = default/Walk-in); the price comes from the DB (`products.mrp` for the default type, `product_prices` for the others — missing price → 422, pegs/servings only under the default type).
- **Stock.** `stock` stays the shop total, so billing, invoices, KOT, breakage keep working untouched. `stock_by_type` holds the explicit counters of non-default types; the default counter is the remainder. Every write respects that: a Janata sale takes from its own counter *and* the total (guarded UPDATEs); a Walk-in sale / breakage / invoice reversal must leave `Σ stock_by_type` alone (the guard is in the SQL). Bottles move between counters with `POST /sale-types/:branchId/transfer` (two `TYPE_TRANSFER` audit rows; the shop total does not change; the target type needs a price first). Supplier invoices are received into the default counter.
- **Counter sheets are per type.** `stock_audit.sale_type_id` says which counter moved, so opening / sold / closing are computed per counter. `Transfer` on a sheet line is the net bottles moved in/out that day (not a sale). Posting a Janata sheet corrects `stock_by_type` and the total together.
- **Accounting for counter sheets.** Posting a sheet books the bottles that left without a POS bill: `unbilled = sold on sheet − billed through POS (same type, same day) − breakage/damage`, at the counter's own rate: `Dr CASH / Cr SALES / Cr OUTPUT_GST` (`COUNTER_SHEET` voucher). Un-posting reverses it (original kept as `COUNTER_SHEET_SUPERSEDED`, reversal as `COUNTER_SHEET_VOID`).
- Prices are edited in one place (Products → "Prices by sale type"), audited in `price_audit` (`sale_type_id`).

### Approved invoices are reversed, never deleted

`DELETE /invoices/detail/:id` refuses APPROVED / REVERSED invoices. `POST /invoices/detail/:id/reverse {reason}` takes the received bottles back out of the default counter (refused if already sold), posts exact reversing vouchers for the purchase and the e-challan payment (`SUPPLIER_INVOICE_REVERSAL`, `SUPPLIER_CHALLAN_REVERSAL`), removes supplier-scheme credit and sets `REVERSED`; the number can then be uploaded again. Purchase vouchers post **no Input GST** (liquor has no creditable input tax): `Dr PURCHASES` at the full line cost. The one-step `/inventory/invoices/approve` and `/parse` endpoints were removed — zero-cost free-goods lines (which only that path accepted) have no entry route yet.
### Bank statement reconciliation (`src/modules/bank/`)

Works with **any bank**: no per-bank templates. `bank.engine.ts` (pure, unit-tested on synthetic statements in several layouts) finds
the header row, infers columns from heading words and, failing that, from cell contents; reads Indian amounts/dates; and decides
debit vs credit from separate columns, Dr/Cr marks, signs, or the **running-balance delta**. The UI lets the user correct the mapping.
Things that are easy to get wrong:
- **Validation is the balance chain** (`verifyBalanceChain`): every running balance must follow from the previous one and opening + credits − debits = closing.
  A `FAIL` blocks the import unless the user ticks "import anyway". `UNVERIFIABLE` (no balances) is allowed but warned.
- **The book side is the BANK ledger**, not bills. It holds card/UPI sales (Dr when paid), supplier challans and bank-mode expenses (Cr), and khata
  repayments by UPI/card. It does NOT hold cash deposits, charges, interest or most supplier payments: **accepting those lines posts a voucher**
  (`sourceType 'BANK_LINE'`, one per line, idempotent) and matches it. Matching a line that is already in the books posts nothing (except a fee gap).
- A card/UPI **settlement** is one statement line ↔ many sale entries; the gap is the gateway fee and is posted as `BANK_CHARGES` (sales are booked gross).
- Nothing is applied automatically: matching only *suggests*. A line that posted a voucher cannot be un-matched (reverse the voucher with a journal).
- **"Reconciled" means the books need no correction** (no statement line missing from them) *and* the figures tie out. Sales awaiting payout are just timing.
  The arithmetic alone always ties out (open items are listed as reconciling items), so never use `difference == 0` by itself.
- Re-uploading overlapping statements is safe: each line has a `hash`; the same file twice is refused. Lines are de-duplicated per account.
- A row with a date but no readable amount is reported (`ROWS_WITHOUT_AMOUNT`), never dropped silently. The first line of a single-Amount-column statement with
  no opening balance is genuinely ambiguous and is flagged `DIRECTION_GUESSED`.
- Account `scope`: `BRANCH` (that branch's BANK ledger) or `SYNDICATE` (every outlet's BANK ledgers; owner only; postings go to the account's branch).
- The statement file itself is **not stored** (privacy): only the hash, the parsed lines and the mapping.
- **Non-store transactions (personal etc.) are IGNORED, never deleted**: no voucher, still on the statement, shown in the Ignored list and in the reconciliation card
  ("left out of the books"). **A reason is required** (`PERSONAL | OTHER_BUSINESS | NOT_OURS | OTHER`) on every ignore, single or bulk
  (`POST /bank/lines/:id/ignore`, `POST /bank/statements/:id/ignore`). Un-ignoring is allowed.
- **Ignore rules** (`bank_ignore_rules`, per account): case-insensitive text in the narration/reference, optional side (IN/OUT) and amount range, min 3 characters.
  `SUGGEST` rules only propose (`suggestion.kind = 'IGNORE'`; confirmed with "Ignore suggested"); `AUTO` rules ignore on import and are labelled (`ignoredByRuleId`).
  Safety rules, all tested: a line that matches a book entry (1:1 or settlement) is **never** auto-ignored; "Accept all matches" never ignores; a line a person
  un-ignored is `ruleExempt` and rules leave it alone from then on; deleting a rule keeps the decisions it already made; rules never cross accounts.

#### Bank reconciliation screen, categories & search, OFX / QIF (`bank-formats.ts`, `ledger-txn.*`, `frontend/src/bank/`)
- The statement screen has **one** summary bar (bank balance, book balance, matched, outstanding, difference; workings behind "How this is calculated") and opens on **Side by side**: Matched | Unmatched bank lines | Unmatched book entries (`BankVsBook.tsx`; "Record…" on a bank line opens the post dialog). The Table tab is the detail view. The landing page has tabs **Statements** and **Transactions & search**.
- **`ledger_transactions`** is the searchable table (date, description, amount, DEBIT/CREDIT, category + lower-cased key, reference, source `BANK_STATEMENT|MANUAL`, `bank_line_id` unique, voucher, recon status, timestamps). A row is written in the same transaction as `postLine`; lines posted before it existed are filled in on the first search (idempotent). Nothing creates `MANUAL` rows yet.
- **Categories are the account's transaction types** (`bank_transaction_types`). `POST /bank/accounts/:id/types/defaults` adds Rent, Wages, Utilities, Supplies (each with its own expense ledger `CAT_*`), idempotently; it is never run silently. Built-in bank categories are stored under their wording (`SALARY_WAGES` → "Wages").
- `GET /bank/transactions/:branchId?q=&category=&from=&to=&direction=` (manager): rows, `totals` (count/debit/credit/net) and `byCategory` over the same keyword/date range but **not** narrowed by the chosen category, so categories can be compared.
- **OFX/QFX and QIF** are sniffed by content (not file name) and turned into the same table a CSV gives, then follow the normal import. OFX (SGML and XML, UTF-8 or Latin-1) has the ledger balance but no running balances, so the statement is not balance-verified. QIF dates have no marker: day first unless a date proves month first (`QIF_DATES_ASSUMED_DAY_FIRST` when all are ambiguous).

#### Super Admin is the software provider, not a shop (`Layout.tsx`, `ProtectedRoute.tsx`)
- A platform owner (owner with no branch or business) sees **only** the Platform menus, has no branch switcher, and any shop URL redirects to `/platform`. Business owners (`owner@`) see the shop menus and no Platform ones. Do not give the Super Admin shop screens.
- Screen names were made plain for Indian shop users (display only; paths, ids and permission keys are unchanged): Match Bank Statement, Peg Control, Supplier Schemes, Excise & Breakage, Counter Stock Sheet, Tables & Orders (KOT), Staff & Billing Counters, Supplier Invoices, Billing (POS), Cashier Shift, Customers & Khata. The same labels live in `roles.engine.ts` (`ROLE_PAGES`).
- A raw `sql` template must never be given a JS `Date` parameter: the real postgres-js driver cannot send it (PGlite can), which made the Platform console fail only on a real database. Use `lt/gte(column, date)`.
- Counter sheet **opening** is editable on a DRAFT sheet by whoever holds `counter.opening` (managers by default); `opening_system` keeps what the system worked out and `opening_edited_by_id` who changed it (putting the number back clears both); each change is audited (`counter.opening.edit`). Sold = opening + inward + transfer − closing, so a corrected opening changes sold and the counter-sheet revenue.
- Supplier Invoices: the list has only an "Add Supplier Bill" button; the single-bill form and the many-bills drop area are both on that screen. A file whose amounts overflow a bill column (a bank statement read as an invoice) is a 422 with a plain message, never a 500.
- `GET /bank/transactions/:branchId` also takes `accountId`; Accounting has a **Bank Transactions** tab (all accounts or one).
- **Round trips are the cost on a hosted database.** A cash bill makes ~24 queries; at 100-250 ms each (Neon from India) that is seconds. Keep the pre-checks of a request in one `Promise.all` wave, do not look the same row up twice, and never add a query to `createBill` or to a `bill.paid` handler without checking the count. `DB_LOG_QUERIES=1` collects every statement in `globalThis.__dbQueries` (`=print` also prints them); a branch's code is cached (`lib/branch-code.ts`, it is immutable).
- Every schema change ships a `drizzle/` migration and a real Postgres has to be migrated by hand (`npm run db:migrate`) before restarting: a missing column fails every bill because the counter-sheet handler runs inside the bill.
- Tests: Playwright reuses whatever is on port 3001. Never run e2e while a developer server is up there (it points at the real database).

### Dashboards & login (`src/modules/dashboard/`, `frontend/src/dashboard/`, `frontend/src/auth/Login.tsx`)

- `GET /api/v1/dashboard/branch/:branchId` (cashier+; payload depends on role: cashier gets own shift, own recent bills, attention, stock; manager/owner get today/yesterday, hourly[24], payment mix, tables, closing steps, top sellers) and `GET /api/v1/dashboard/owner` (owner with a syndicate; platform owner gets 422). Everything is aggregated server-side (never sum a paged bill list in the browser).
- Pure logic lives in `dashboard.engine.ts` (hourly buckets, same-time-yesterday, khata FIFO ageing, ranked attention items). A shift is flagged only if open ≥12h (staff) / ≥10h (cashier); yesterday not closed = bad.
- Frontend CSS is scoped under `.lc` / `.dark .lc` with an `lc-` class prefix, because global `.card/.input/table` dark overrides would otherwise clash. Fonts are self-hosted via `@fontsource`. Sidebar and other pages keep the older purple theme.
- Login: 401 body carries `attemptsLeft`; 429 carries `retryAfterSeconds` (+ `Retry-After`). Throttle counters live in the `login_throttle` table (migration 0031; shared by every instance, survives restarts; per email+IP: 10, per account: 100); set `TRUST_PROXY` behind a proxy. `GET /api/v1/health` feeds the login status chip.
- There is no second UI: the old single-file `preview.html` is no longer served and no test uses it. The e2e specs all drive the React app (`npm run build:frontend` first). Playwright runs 3 workers with a 10 s expect timeout because one server process hashes every worker's password logins.

### Frontend look (app-wide)

- The whole app shares one palette, defined in `frontend/src/index.css` under `@theme`. The screens are written with Tailwind's `purple` and `gray` classes, so those ramps were **redefined**: `purple-*` is the brand green (primary buttons, active states, links), `gray-*` and `slate-*` are green-tinted neutrals, `blue-*` is a calm card-blue, `green-*`/`emerald-*` is the "good" green, `indigo-*`/`violet-*` alias the brand green. Do not look for purple on screen: changing the look means editing those ramps, not the screens.
- The dark-mode overrides lower in `index.css` use the matching dark hex values (surface `#111c18`, background `#0a1310`, line `#253630`). `th` has one base style for every table (it sits in `@layer base`, so a screen's own classes still win).
- Fonts are self-hosted (`@fontsource`): Hanken Grotesk for text, Bricolage Grotesque (`font-display`) for headings and big figures, IBM Plex Mono for codes.
- The sidebar is dark green in both themes. The sign-in, forgot and reset password screens share `auth/AuthShell.tsx`. The dashboards use the scoped `lc-` classes in `dashboard/lc.css`.
- Screens redesigned beyond the palette: POS (stacks on phones, empty-cart state, payment-mode icons), Tables & KOT (grouped by section, how long a table has been open, grouped action dialog), Inventory (header, tabs, stepper), Platform and the dashboards. Decorative emoji were removed from headings and text; the product-category illustrations in `components/category-icons.tsx` are data and stay.

### Super Admin console (`src/modules/platform/`, `frontend/src/platform/`)

- `GET /api/v1/platform/dashboard` (platform owner only) feeds the top of the console: MRR, paying/trial counts, unpaid invoices, outlets/staff, 30-day sales vs the 30 days before, plan mix, 30-day sign-up funnel, money collected per month, and the **"needs action" queue** (`trialEnding`, `overdue`, `quiet`, `suspended`, each `{count, ids}`).
- `GET /platform/tenants` now also returns `health` (0-100) and `flags` (queue keys) per tenant, and `lastBillAt` is the latest PAID bill ever (it used to be limited to the last 30 days).
- Rules are pure and unit-tested in `insights.engine.ts`: MRR = active paid-plan tenants whose access is OK; trial ending = within 4 days or already ended; overdue = paid plan whose `paidUntil` has passed (it can still be inside the 7-day grace, so the tenant stays usable); quiet = no bill for 7+ days, or never billed after a week; health = recency 50 + volume 25 + staff 10 + good standing 15, capped at 40 when access is blocked. The health weights are a judgment call: change them in one place.
- "Collected" revenue is grouped by the month the invoice was **paid** (`paidAt`), not by billing period, so a renewal paid early counts in the month the money arrived. It is cash collected, not accounting revenue.
- No plan history is stored, so the funnel is "signed up in the last 30 days / have billed / are now on a paid plan", not a true trial-to-paid conversion rate.

### Super Admin: users, audit, plans, lifecycle, branches, roles (`src/modules/platform/`, `src/modules/permissions/`)

Sidebar group "Platform" (Super Admin only): Platform Console, Roles & Permissions, Branches, Plans & Billing, Users, Audit Log. Every endpoint below is `superAdminOnly`.

- **Users** (`GET /platform/users`, `PATCH /platform/users/:id {isActive}`, `POST .../reset-password`, `PUT .../role`): all users across businesses. `users.last_login_at` is set at sign-in. Platform owners and yourself cannot be changed.
- **Audit** (`GET /platform/audit?actor=&action=&tenantId=&from=&to=`, `/audit/actions`): the business of an event is the actor's, or the target's (`tenant` / `syndicate` / `user` / `branch` targets are resolved). Events carry `before`/`after` in `meta`. There is no IP column.
- **Plans** (`saas_plans`, `plans.service.ts`, pure maths in `plans.engine.ts`): plans are data, not constants (`syndicates.plan` stores a plan code). TRIAL always exists, is free and cannot be retired. A retired plan cannot be chosen but its holders keep it and are billed its price. A new price only affects invoices raised later. `previewPlanChange` / `assignPlan` credit the unused days of a plan **that was actually paid for** (a paid invoice exists; the 30-day courtesy earns nothing), now or scheduled up to 90 days ahead (`syndicates.next_plan`, applied by `applyDuePlanChanges()` whenever tenants are read or the billing job runs). MRR counts a plan's monthly equivalent.
- **Lifecycle** (`tenant-lifecycle.service.ts`): archive (reason required; blocks sign-in, leaves the figures) → restore, or export (JSON of every owned row, no password hashes) → permanent delete, only after 30 days archived (`ARCHIVE_RETENTION_DAYS` can shorten it outside production only), no unpaid invoice, exact business name typed. Delete finds what a business owns by walking the database's foreign keys downward from `syndicates`, so new tables are covered; `audit_log` is the one table kept (its `actor_id` is cleared). It is one transaction: any problem rolls back. A query inside a transaction must use `tx`, not `db`: PGlite deadlocks otherwise.
- **Branch features** (`branch_features`, `features.engine.ts`, `branch-admin.service.ts`): only switched-off features are stored. A global `preHandler` in `app.ts` refuses a switched-off feature's URLs (403 `FEATURE_DISABLED`) for the branch named in the path, query or body, else the user's own branch. Switchable: bank, accounting (+expenses), bar (tables, KOT), invoices, schemes, counter sheets, closing, excise quotas/lifting/stock-audit. **Not** switchable, because the POS depends on them: sale types, customer credit, breakage, pour control, menus. `GET /branches` returns `disabledFeatures`; the frontend hides the pages (`lib/features.ts` mirrors `features.engine.ts`).
- **Roles** (`roles`, `users.role_id`, `permissions/roles.engine.ts`, `roles.service.ts`): a role = **level** + granted **permissions** + default **pages**. The five built-in roles (`is_system`) are fixed and keep the code defaults (manager: every permission, cashier/steward: none), so a permission added later follows that rule for them. A **custom** role (Super Admin only; level steward / cashier / manager, never above manager) carries an explicit permission set and, when none of the person's own menu rows exist, a default menu. `users.role` always holds the level, so the 138 `requireRole` guards are unchanged; `users.role_id` is NULL for a built-in role. `can()` / `effectivePermissions()` take the role's set as an optional last argument (`loadRolePermissions`). Editing a role applies on the next request; changing its level moves its people. Roles are retired, not deleted. `roles.level` is **text**, not the enum: a migration cannot use an enum value added in the same run.

### POS and Tables screens (`frontend/src/pos/`, `frontend/src/tables/`)

- **POS** (`POS.tsx`, rules in `posLogic.ts`, credit panel in `KhataPanel.tsx`): built for a scanner AND touch. The search box is focused on a fine pointer (not on touch); Enter adds an exact barcode match, else the only visible product (`resolveScan`). Shortcuts: F2 search, F4 park, F8 parked list, F9 / Ctrl+Enter checkout, Alt+1-4 payment, + / - / Delete on the last touched line, digits pick a serving; any letter or digit typed outside a field goes to the search box. Cash has a tender box (`tender`, `quickCashOptions`): nothing typed = exact; too little blocks checkout. The tender is **screen-only**: the bill API takes no received/change, so the change shows on the receipt modal only. A discount is a percentage or rupees, held to the cashier's cap (`discountFromPercent/Amount`, floored to the paisa). Parked bills (max 10) and "recent" items live in localStorage (per person / per branch); a resumed bill is rebuilt from the CURRENT catalog. The offline queue, per-cart `clientRef` and every element id the e2e tests use were kept. On a phone the cart is a sheet opened from a bottom bar.
- **Tables** (`Tables.tsx`): `GET /tables/:branchId` now returns, per occupied table, `sessionTotal` (sum of non-cancelled KOT items at MRP, tax included), `sessionItems`, `sessionToServe`, `sessionLastOrderAt`, `sessionStewardName` so the tile shows the running bill. The floor refreshes every 30 s. A table is flagged after 10 min with items waiting or 3 h open. `POST /tables/:id/move {toTableId}` (steward+; target must be FREE) moves the open session; `POST /tables/:id/merge {intoTableId}` (cashier+) moves every KOT order to the other open session, adds guests, closes the first session and frees its table. Both audit (`table.move`, `table.merge`) **after** the transaction commits.

## 9. Conventions

- Money: `numeric(12,2)` in DB, decimal strings in TS, `decimal.js` for arithmetic, `.toFixed(2)` on output;
  zod money regexes cap integer digits so oversized values fail validation (400) instead of overflowing the column.
- Validate params and bodies with zod `safeParse`; map service errors with `sendError`.
- Multi-table writes go in `db.transaction`; every stock change gets a `stock_audit` row.
- Idempotency for client retries: `clientRef` on bills and repayments.
- Commit style: conventional commits (`feat(scope): ...`, `test(e2e): ...`, `chore(db): ...`).

### Master catalog, mapping and prices (`src/modules/catalog/`, migration 0032)

- **A supplier invoice has no MRP (migration 0036).** It records what the business PAID: quantity, cost price, case rate. `supplier_invoice_items.mrp` is dropped; a line needs only quantity and cost to be reviewed or approved (so an unpriced new product no longer blocks an invoice); the `MRP_CHANGED` / `COST_ABOVE_MRP` flags are gone; approval never changes `products.mrp` or writes `price_audit`; the draft never copies the catalog price. An MRP *column printed on an uploaded document* is still read by the extractor, only to tell a per-case rate from a per-bottle rate, and is never stored. ("MRP rounding off" on ICDC challans is a different thing: a printed total adjustment, unchanged.) The selling price is typed only in Products → Pricing (or `PATCH /products/:id/mrp`).

- **Three layers.** (1) Platform, no tenant, **no prices**: `categories` with `syndicate_id` NULL and `master_products` (+ `master_product_barcodes`), per state (`branches.state_code`, default 'TS'). (2) The business: `products` has `syndicate_id` NOT NULL; `master_product_id` says which master product it is (NULL = the business's own item: bar menu, kitchen, local brand); unique `(syndicate_id, master_product_id)`, so a master product is mapped once. (3) Prices: `products.mrp` is the business-wide price and `branch_product_prices` a branch's own price (`sale_type_id` NULL = default type).
- **Nobody invents a price.** Mapping from the master, an invoice upload (`provisionMasterProducts`) or a brand-code mapping creates the product with `mrp 0.00` and no cost. Billing, KOT and the POS refuse an unpriced product (`needsPrice`); the Products page has a **Pricing** tab (business price + the active branch's override, "Needs price" filter, paste/CSV of `sku,price`) and **Add from master catalog**.
- **Price order** (`price.engine.ts`, pure, unit-tested): default type = branch override, else `mrp`; another sale type = branch override for that type, else `product_prices`, else the default-type price. `createBill` loads the overrides in its existing `Promise.all` wave (no extra wait); KOT and counter sheets use the same engine.
- **Mapped identity is the master's.** On a mapped product only name (a display name), barcode and active can change; brand, size, pack, SKU, excise code and category → 422.
- **Categories:** `syndicate_id` NULL = platform (only the platform / seed creates them, `upsertMasterProducts` adds missing ones), set = the business's own (menu / kitchen). Names are unique per owner (case-insensitive). Mapping never creates a category; a master product whose platform category is missing is skipped with a reason.
- **Tenant scope** is `productTenantScope(tenant)` (strict `syndicate_id = tenant`; a user without a business sees nothing; the old "NULL = shared with everyone" rule is gone). `createProduct` / `createMenuItem` need a concrete business (the platform owner must act through a branch). Brand-code mappings carry `syndicate_id`; list, create and delete are scoped to it and the product / branch must belong to the same business. Approving an invoice refuses products of another business.
- **Cost is per branch** (`branch_product_costs`, migration 0034): approving a supplier invoice upserts what THAT branch paid (and its "previous cost" is that branch's own last purchase, none if it never bought the item; never another outlet's). `GET /products?branchId=` returns the branch's cost figures (none if it never bought the item); without a branch it returns the business-wide "latest" on `products.cost_*`, which is still written for legacy rows. Breakage is valued at the branch's cost.
- **Master catalog changes reach businesses** (migration 0035): `master_products.revision` rises when brand, pack, SKU or category change (a rename or discontinuing does not); `products.master_revision` is what the business last synced. `GET /catalog/master/updates` lists the differences (and discontinued items), `POST /catalog/master/updates/apply` (manager) copies brand / size / pack / SKU / excise / category only, never price, cost, stock or the display name. The Products page shows an "N updates" badge and the master tab an "Update all" panel.
- **Super Admin edits the master** (`platform/master.routes.ts`, page *Master Catalog*): `GET/PATCH /platform/master/products`, `POST /platform/master/import` (CSV rows; creates missing platform categories at 18%), `GET/POST/PATCH /platform/master/categories` (GST per category). Everything is audited.
- **Sale types:** the price matrix (`GET /sale-types/:b/prices`) also returns each product's `branchPrices` (`default` or sale-type id → price); the sale-price grid has a "Business price / This outlet only" switch and the POS uses the outlet's own typed price.
- **Soft delete vs hard delete of a business:** *Archive* sets `syndicates.is_deleted = true` (+ `archived_at`, `is_active = false`): the business disappears from every screen and nobody can sign in, but every row (products, bills, books) is kept and *Restore* brings it back. Only the Super Admin's **Hard delete** (Archived row → "Hard delete…") removes rows, and only for a soft-deleted business after 30 days (`ARCHIVE_RETENTION_DAYS`, production always 30), with no unpaid invoice and the exact name typed. A business's products are its own and go with it.
- **Not done (deliberate):** row-level security on the catalog tables. The app does not run queries inside `withTenant`, and the test database (PGlite) runs as superuser, so turning RLS on would either break every query or protect nothing; tenant scoping is enforced in code (`productTenantScope`, `branchTenantId`) and tested. The business-wide `products.cost_*` fields are not yet dropped.
- **Migrations 0033 (soft delete flag), 0034 (branch costs, seeded from each product's last invoice) and 0035 (master revisions) are plain additions.**
- **Migration 0032 refuses to run if any product has a NULL `syndicate_id`** (assign it first). It also backfills `master_product_id` where SKU or excise code + volume match, adds missing platform categories, drops `master_products.reference_mrp` / `reference_cost`, and adds `brand_code_mappings.syndicate_id` (from the mapping's product). A real Postgres must be migrated before restarting.

### Code-review hardening (2026-11)

- `skipStockDeduction` is **not** a request field any more: `createBill(input, user, { internal: { skipStockDeduction } })` is server-side only (table checkout, whose stock left at KOT-serve time). Voiding only works on `PAID` bills.
- A request reads a user's permission overrides + custom role **once** (`snapshotOf` in `permission.service.ts`, a WeakMap keyed on the `request.user` object). Never call `userCan` with a long-lived user object, and do not use it for a *different* user's permissions after changing them.
- `/health` and `/api/v1/health` run `select 1` (503 `degraded` if the DB is down). `sendError` turns network-looking plain Errors into 500.
- Print agent: unique index on `branches.agent_token_hash` (0030), `last seen` written at most every 5 s, jobs claimed in one `FOR UPDATE SKIP LOCKED` statement.
- Supplier-invoice extraction runs through `lib/limiter.ts` (`INVOICE_EXTRACT_CONCURRENCY`, default 2; queue of 20, then 503). Upload type is detected by magic bytes (`detectFileType`), never by file name.
- Voucher numbers are `JV-<branch>-<yyyymmdd>-<12 hex>`. A statement imported past a failed balance check is audited (`bank.statement.balance_override`).
- Migrations 0030 (agent token index) and 0031 (`login_throttle`) must be applied (`npm run db:migrate`) on a real Postgres **before** restarting: without `login_throttle` every sign-in fails.

### Review follow-up, groups 1-5 (2026-11-19, migrations 0037-0041)

- **Voucher balance is a database rule** (0037): a deferred constraint trigger on `journal_lines` refuses a voucher whose debit and credit differ at COMMIT.
- **Counted counter-sheet closing is kept** (0038, `daily_counter_sheet_lines.closing_manual`): a closing that differs from the books is a physical count and later bills do not recompute it; lines nobody counted still follow the bills.
- **A password change or reset ends older sessions** (0039, `users.password_changed_at`): `requireRole` refuses a token whose `iat` is older (whole seconds). `POST /auth/change-password` returns a fresh `token` so the caller stays signed in. The frontend routes every call through `authFetch` / `handleResponse`, and a 401 on a request that carried a token signs the person out once (`api/session.ts`); the POS parks a bill in the offline queue before that happens. Offline bills the server rejects (4xx other than 401) move to a "failed bills" list, never dropped.
- **Constraints** (0040): `CHECK`s on stock, stock_by_type (`>= 0`), bills, bill_items, expenses and credit_transactions amounts; `journal_lines.voucher_id` is `ON DELETE RESTRICT`; `bill_counters` has a primary key. They are added NOT VALID then validated, and a validation failure only WARNs. `customers.current_credit` deliberately has no `>= 0` check (a void after a repayment leaves a customer in credit). Stock deltas that may be negative use `lib/stock-delta.ts` (`addStockDeltas`), never `INSERT ... ON CONFLICT quantity + EXCLUDED.quantity` (a CHECK is tested on the proposed row first). Every index, CHECK and FK that a raw-SQL migration creates must also be declared in `schema.ts` (`tests/unit/schema-drift.test.ts` enforces it for 0025 and 0040).
- **Drawer cash** = opening + cash sales + cash khata repayments - cash expenses - withdrawals (`lib/cash-movements.ts`; shift summary, daily closing, closing preview and the cashier dashboard all use it; `daily_closings.cash_repayments` / `cash_expenses`, 0041). A day cannot be closed while a shift is open. A closed business day takes no more bills (`lib/closed-day.ts`, checked in `createBill`'s pre-check wave; a `clientRef` replay is answered before it). An office admin or owner reopens a day with `POST /closing/:id/reopen {reason}` (the record is kept in the audit log).
- **Inventory reset** (`DELETE /inventory/stock/:branchId/clear`) is office admin / owner only, audited, and only forgets that branch's costs.
- **Operations**: the server refuses to start against a PostgreSQL that is behind the migrations (`db/migration-status.ts`; `AUTO_MIGRATE=1` applies them at boot for a single instance), handles SIGTERM / SIGINT gracefully, and the frontend loads every screen except sign-in, dashboard and POS lazily (the POS stays eager so a cashier who goes offline already has it). CI is `.github/workflows/ci.yml`; deploy, backup and restore steps are in `docs/RUNBOOK.md`.

### Security hardening, group 6 (2026-11-19, no migration)

- **Support sign-in** (`/platform/tenants/:id/impersonate`): the token cannot change passwords, users, roles or touch `/platform/*` (`impersonation.engine.ts`, enforced in `requireRole`), and every `logAudit` made with it carries `meta.impersonatedBy` (per-request `AsyncLocalStorage`, `lib/request-context.ts`, opened by an `onRequest` hook in `app.ts`).
- **Reset links**: a delivered (`SENT`) password-reset mail is stored in `email_outbox` with its token removed (`notifications/redact.ts`); with no SMTP the outbox is the only copy, so it is kept in development, and `GET /platform/outbox` hides it in production.
- **Sign-in timing**: an unknown or inactive e-mail spends one bcrypt compare against a throwaway hash, so response time does not reveal which accounts exist.
- **Production boot refuses** `TRUST_PROXY=true` (spoofable `X-Forwarded-For`; use a hop count or CIDR list) and the `.env.example` `JWT_SECRET` placeholder.
- **Uploads**: an `.xlsx` whose zip directory claims too much uncompressed data is refused before it is inflated (`lib/zip-guard.ts`). PDF page limits are still applied after parsing.
- **Printer host** (`lib/print/address-policy.ts`): link-local (cloud metadata) and unspecified addresses are always refused; loopback in production; `PRINTER_BLOCK_PRIVATE=1` also refuses private ranges (hosted install with no LAN printers). The check runs at save time and again on the resolved address at connection time.
- Quality modules: a module's `ownerId` / `parentId` must belong to the same business.

### Remaining security items closed, group 7 (2026-11-19, migration 0042)

- **Forced password change** (`users.must_change_password`, 0042): set by every administrator reset (manager reset, Super Admin tenant-Admin and user resets), cleared when the person changes their own password or uses an e-mailed reset link. While it is set `requireRole` answers 403 `PASSWORD_CHANGE_REQUIRED` to everything except `GET /me` and `POST /auth/change-password` (`isAllowedWhilePasswordChangeRequired`); `/me` returns `mustChangePassword` and the app shows a non-dismissible "Choose a new password" dialog. Tests that reset a user's password must clear the flag afterwards if they keep using that user's token.
- **Account-wide sign-in lock** no longer shuts out the real user: a client (e-mail + IP) with a successful sign-in in the last 30 days (`known:` rows in `login_throttle`, outside the 15-minute housekeeping) is exempt from the 100-failure account counter, though not from its own 10-failure counter.
- **Support sign-in**: the browser no longer keeps the Super Admin's token (`support_return_token` is gone). `POST /auth/support-return` takes the support token, checks that `impersonatedBy` is still an active platform owner and issues a fresh Super Admin token (audited as `support.sign_out_as`); it is not on the impersonation block list.
- **PDF**: the OCR render scale is reduced so a page that declares a giant size cannot allocate a giant canvas (`renderScaleFor`, 24 MP cap), and at most 50 000 text pieces are kept per page.

### Books and stock control, group 8 (2026-11-19, migration 0043)

- **Expense void** (`POST /expenses/:branchId/:id/void {reason >= 10 chars}`, needs `accounting.post`): an expense is never deleted. `expenses.voided_at / voided_by_id / void_reason` (0043); the `expense.voided` domain event posts an exact reversing `JOURNAL` voucher (`EXPENSE_VOID`) in the same transaction. A voided expense stays in `GET /expenses/:branchId` (marked) but is outside `total` / `totalsByCategory` and the drawer arithmetic (`lib/cash-movements.ts`). A **cash** expense dated on a closed business day can be neither recorded nor voided until the day is reopened (`assertBusinessDayOpen`); card / UPI / bank expenses do not touch the drawer.
- **Cash book / bank book** (`GET /accounting/cash-book/:branchId?ledger=CASH|BANK&from=&to=`, `accounting.view`): the ledger regrouped by day (opening, receipts, payments, closing, entries) by the pure `cashbook.engine.ts`. The day book already existed as `GET /accounting/vouchers/:branchId`. The Accounting page has **Cash Book** and **Expenses** tabs (the app had no expenses screen before).
- **Stock-take** (`POST /inventory/stock/:branchId/adjust {note, lines: [{productId, countedQuantity}]}`, new permission `stock.adjust`: manager and above by default, grantable to a cashier): sets the shop total of each counted product to the count. Pure rules in `stock-adjust.engine.ts` (a count below what the other sale-type counters hold is refused: move stock between counters first); the rows are locked `FOR UPDATE`; every difference is a signed `MANUAL_ADJUST` `stock_audit` row whose `reference_id` is the batch id, and the reason goes to the audit log (`stock.adjust`). No voucher is posted (periodic inventory, see known gaps). Inventory has a **Stock Count** dialog (`StockCount.tsx`).
- `DELETE /inventory/stock/:branchId/clear` is office admin / owner only; the "Clear Store Stock" button now says so (`minRole="office_admin"`).
- **GST returns were deliberately not built.** Alcohol for human consumption is outside GST (state excise / VAT apply), purchases already post no input GST, and a GSTR-style report over liquor sales would be wrong. The sales voucher still splits `OUTPUT_GST` by the category rate (a configuration question for the accountant, not a report).

### Remaining features, group 9 (2026-11-19, migrations 0044-0047)

- **Stock transfers between outlets** (`modules/transfers/`, 0044 `stock_transfers` + `stock_transfer_items`; new permission `stock.transfer`, manager and above by default). `POST /transfers` dispatches: the bottles leave the sender's DEFAULT counter at once (guarded SQL, `TRANSFER_OUT` audit rows) and are IN_TRANSIT, in neither shop. `POST /transfers/:id/receive {items?: [{productId, receivedQuantity}]}` is confirmed by the RECEIVING outlet only (`TRANSFER_IN` into its default counter; anything below what was sent stays on the line as lost in transit; a receiving outlet with no cost of its own for the bottle starts from the sender's). `POST /transfers/:id/cancel {reason}` is the SENDER's, while in transit (bottles go back). Both outlets must belong to the same business. `GET /transfers?branchId=`, `GET /transfers/:id`, `GET /transfers/destinations?branchId=` (the other outlets of the business: a branch user cannot list branches). No voucher is posted (periodic inventory). UI: a "Transfers between outlets" panel in Inventory.
- **Supplier payments and creditors ageing** (`accounting/supplier-payments.service.ts`, pure rules in `creditors.engine.ts`, 0045 `supplier_payments`). The books keep one `SUNDRY_CREDITORS` control ledger, so what each supplier is owed is DERIVED: approved invoices (lines + printed charges, exactly what approval credited) less the e-challan paid with the invoice, less recorded payments and goods returned (a debit note). Money is applied to the OLDEST invoice first; ageing buckets are 0-30 / 31-60 / 61-90 / 90+ days from the invoice date; payments beyond what is owed are an advance. `GET /accounting/suppliers/:branchId/ageing?asOf=`, `GET|POST .../payments`, `POST .../payments/:id/void {reason}` (voided, never deleted; reversing voucher `SUPPLIER_PAYMENT_VOID`). A payment posts Dr SUNDRY_CREDITORS / Cr CASH (cash) or BANK (UPI / card / bank). A **cash** payment leaves the drawer: it is part of the closing's cash-paid-out figure (with cash expenses and cash refunds), and a closed day refuses it. UI: Accounting → Suppliers.
- **Returns** (0046). *Customer return* (`POST /bills/:id/returns {reason, items:[{billItemId, quantity}]}`, permission `bills.void`): only a PAID bill; pegs / glasses cannot be returned; the refund is the returned share of what the customer actually paid, i.e. the gross share less the share of the bill discount (`return.engine.ts`; the last bottle of a line takes the exact remainder so part-returns add up to the paisa); stock goes back to the counter it was sold from (`SALES_RETURN` audit rows); a khata sale reduces the customer's balance (an `ADJUSTMENT` credit transaction) instead of paying cash; the voucher is the sale voucher reversed (Dr SALES, Dr OUTPUT_GST, Cr DISCOUNT_ALLOWED, Cr CASH | BANK | SUNDRY_DEBTORS). Cash refunds leave the drawer figure; a closed day refuses a return. Not reflected on a DRAFT counter sheet (count the closing by hand: a counted closing is kept). *Return to a supplier* (`POST /purchase-returns`, permission `invoices.approve`): bottles leave the default counter (`PURCHASE_RETURN`), cost defaults to what the outlet last paid, voucher Dr SUNDRY_CREDITORS / Cr PURCHASES, and it reduces what is owed in the ageing. Neither return can be reversed (record a correcting entry). UI: a Return button on Bills; "Return goods to a supplier" in Accounting → Suppliers.
- **Margin report** (`GET /reports/margin/:branchId?from=&to=`, needs `cost.view`; `reports/margin.engine.ts`): revenue net of tax and bill discount less quantity x THIS outlet's cost (`branch_product_costs`, else the business-wide last cost); pegs count as a fraction of a bottle; customer returns in the period come off quantity and revenue; a product with no known cost is listed with a blank margin and left out of the totals. Accounting → Margin.
- **Excise stock register** (`GET /compliance/stock-audit/:branchId/register?from=&to=&format=json|csv`, `.../register/:productId` day by day, manager+; pure `compliance/register.engine.ts`): per product opening, received, transfer in / out, returned to supplier, sold (net of voids and customer returns), sold without a bill (counter-sheet corrections), breakage, adjustments, closing, in bottles and litres. The closing is anchored to the LIVE stock quantity (closing = quantity now minus everything moved after the period), so stock seeded before audit rows existed cannot skew it; opening + in - out = closing holds by construction. It is a generic register, not a specific state's statutory format: map its columns to the form your excise office wants. Excise & Breakage page has the view and a CSV download (that page uses the user's own branch, as before).
- **Built-in error tracking** (`modules/errors/`, 0047 `error_events`): no outside service. Unexpected server errors (`sendError`'s 500 paths, via `setErrorCaptureHook`, and an `onError` hook for anything a route throws) and uncaught browser errors (`lib/error-report.ts` -> `POST /client-errors`, public, 20/min per IP in production, 16 KB cap) become ONE row per distinct error (a fingerprint of the message with ids and numbers removed plus the first stack frame), counted; a resolved error reopens by itself if it recurs. Nothing private is stored: no request body or headers, the route WITHOUT its query string, e-mail addresses and 9+ digit runs masked (`error-scrub.ts`). `ERROR_WEBHOOK_URL` (optional, Slack / Teams / ntfy style `{text}`) is POSTed once per NEW error with the same scrubbed data. Super Admin: `GET /platform/errors`, `POST /platform/errors/:id/resolve`, page Platform -> Errors.
- **Offline-capable PWA** (`frontend/public/sw.js`, `manifest.webmanifest`, `icons/` made by `scripts/make-pwa-icons.mjs`, `lib/pwa.ts`): registered in the built app only. The page is network-first with the saved copy as fallback (so a tablet restarted while the internet is down still opens, on any route); built files are cache-first (content-hashed); a short list of read-only GETs (`/me`, `/branches`, `/products`, sale types, branch stock) is served from the last good copy when the network is down. **Those copies are per signed-in user** (a query parameter derived from a hash of the token; NOT a URL fragment, which the Cache API ignores) and are wiped on every sign-out. Writes, other sites and every other API call are never touched, and only 2xx responses are kept. `AuthProvider` no longer signs a cashier out when `/me` fails because the network is down: only a 401 / 403 ends the session. Bills made offline are still queued by the POS itself. `tests/unit/service-worker.test.ts` runs the real `sw.js` in a sandbox with a fake Cache API.

### Found while verifying group 9 (2026-11-19)

- **Lazy screens need precaching.** Every screen except sign-in, dashboard and POS is its own file, so the service worker precaches EVERY built script and stylesheet at install (`/precache.json`, written by the `offline-precache` plugin in `frontend/vite.config.ts`, which also stamps a build id into `sw.js`: a byte-identical worker is never updated by the browser). A file that fails to cache is retried once. Without this a cashier who goes offline and opens a screen they had not visited would get nothing.
- **A support sign-in is exempt from the forced password change** (`requireRole` skips it for tokens with `impersonatedBy`, and `/me` reports `mustChangePassword: false`): the Super Admin acting as a tenant Admin cannot change that person's password.
- **Day Closing ignores out-of-order previews**: the page asks for today's figures when it opens and again when the date changes; only the newest request may fill the form (a `previewSeq` ref), and Submit is disabled while figures load. Before, a slow older answer could put today's sales under another date and they were submitted.
- **E2E notes**: the Playwright web server needs about 60-90 s to boot (PGlite migrations + seed) and the config allows 180 s; on a busy machine start it yourself (`DATABASE_URL=pglite://./.pglite-e2e PORT=3001 NODE_ENV=development SEED_DEMO_STOCK=true ARCHIVE_RETENTION_DAYS=0 node --import tsx src/dev-local.ts`) and Playwright will reuse it. The e2e database is shared: a spec that closes a day (Journey 6, owner-branch-closing) locks it for later runs, so start from a fresh `.pglite-e2e`. In a spec, wait for something with `expect.poll`, not `page.waitForFunction` with an async callback. **Ten e2e specs fail on the last committed code too** (checked in a clean checkout of HEAD): accounting-and-roles, bank-transactions (flaky), credit-khata, dashboard-login, dialogs-and-manual-bill, Journey 1, Journey 4, Journey 5, steward-tables, supplier-invoices. They are stale expectations from earlier UI changes (`#userDisplay` text case, the Inventory page id is now `page-inventory`, two "Add Supplier Bill" buttons, ...), not regressions.
