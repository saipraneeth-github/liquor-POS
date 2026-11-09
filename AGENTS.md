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
- Catalog: `categories` (GST `taxRate`) → `products` (barcode, sku, `mrp`, `costPrice`, `packQuantity`, `exciseCode`); `price_audit`
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

Role rank: `steward(1) < cashier(2) < manager(3) < office_admin(3.5) < owner(4)`. `requireRole('x')` allows that role and above,
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
- Product MRP is global (not per branch); changes are recorded in `price_audit`.
- Purchases use periodic inventory (debited to PURCHASES; no automatic closing-stock entry).
- Slab payouts use the "best slab reached" rule (non-cumulative) and assume `scheme_purchases.qty` is in cases.
- Closing selects bills by creation date; voiding a bill from an already-closed day is not reflected in that closing.
- Windows PowerShell 5.1 `Get-Content` mis-displays UTF-8 (box-drawing comments look like `â”€`); the files are fine — use `-Encoding utf8`.
- `.agents/` and `README.md` describe generic AI tooling, not this app; ignore them for project context.

### Permissions (`src/modules/permissions/`, Staff & Terminals → Access)

- **Office Admin** runs the business for the owner: above a manager, below the owner. Everything inside the business, nothing above it: the platform console, creating outlets, subscription billing and business-wide shared bank accounts stay owner-only. Only the owner creates an office admin; an office admin creates managers / cashiers / stewards; a manager creates cashiers / stewards. `ProtectedButton` and the guard use the same ranks.
- **Actions** are permissions with role defaults (owner / office admin / manager = all, cashier / steward = none) and per-user overrides in `user_permissions`: `cost.view`, `prices.edit`, `sale_types.manage`, `stock.move`, `invoices.approve` (needs `cost.view`), `bills.void`, `discount.unlimited`. Owner and office admin cannot be restricted. Use `requirePermission(key)` after `requireRole('steward')` on a route; the permission, not the rank, decides. Only users below you can be changed and nobody can grant what they do not hold (`GET/PUT /users/:id/permissions`, manager+). `/me` returns the effective `permissions`, `discountCapPct` and `saleTypeIds`.
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

### Dashboards & login (`src/modules/dashboard/`, `frontend/src/dashboard/`, `frontend/src/auth/Login.tsx`)

- `GET /api/v1/dashboard/branch/:branchId` (cashier+; payload depends on role: cashier gets own shift, own recent bills, attention, stock; manager/owner get today/yesterday, hourly[24], payment mix, tables, closing steps, top sellers) and `GET /api/v1/dashboard/owner` (owner with a syndicate; platform owner gets 422). Everything is aggregated server-side (never sum a paged bill list in the browser).
- Pure logic lives in `dashboard.engine.ts` (hourly buckets, same-time-yesterday, khata FIFO ageing, ranked attention items). A shift is flagged only if open ≥12h (staff) / ≥10h (cashier); yesterday not closed = bad.
- Frontend CSS is scoped under `.lc` / `.dark .lc` with an `lc-` class prefix, because global `.card/.input/table` dark overrides would otherwise clash. Fonts are self-hosted via `@fontsource`. Sidebar and other pages keep the older purple theme.
- Login: 401 body carries `attemptsLeft`; 429 carries `retryAfterSeconds` (+ `Retry-After`). Throttle is in-memory (per email+IP: 10, per account: 100); set `TRUST_PROXY` behind a proxy. `GET /api/v1/health` feeds the login status chip.
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

## 9. Conventions

- Money: `numeric(12,2)` in DB, decimal strings in TS, `decimal.js` for arithmetic, `.toFixed(2)` on output;
  zod money regexes cap integer digits so oversized values fail validation (400) instead of overflowing the column.
- Validate params and bodies with zod `safeParse`; map service errors with `sendError`.
- Multi-table writes go in `db.transaction`; every stock change gets a `stock_audit` row.
- Idempotency for client retries: `clientRef` on bills and repayments.
- Commit style: conventional commits (`feat(scope): ...`, `test(e2e): ...`, `chore(db): ...`).
