# PLAN — Kitchen Menu, Bar Menu (peg pricing), Printing, GST bills

## 1. Codebase findings (before changes)

| Area | Finding |
|---|---|
| Stack | Fastify 5 + Drizzle (Postgres / PGlite) + zod; React 19 + Vite + Tailwind 4 frontend (`frontend/`). Engine / service / routes split per module. |
| Catalog | Single `products` table (liquor-oriented: `volumeMl`, `packQuantity`, `exciseCode`, tax-inclusive `mrp`). GST % lives on `categories.tax_rate`. No description, no availability flag, no food concept. |
| Rates | `PATCH /products/:id/mrp` (manager) writes `price_audit`. **No endpoint or UI to read price history.** |
| Servings | None. Billing, KOT and stock all work in whole units (bottles). No peg/glass concept. |
| Stock | `stock.quantity` (integer bottles). Billing refuses to sell without stock rows -> food items could never be billed. |
| KOT | `kot_orders` / `kot_items` + consolidated session summary; items snapshot MRP and GST rate. No printing of KOTs. |
| Printing | `src/lib/print/` (ESC/POS builder + `generateReceiptBuffer`) **exists but is not wired to anything** (no route, no UI, no printer config). Limitations: no item names from DB, no CGST/SGST split, no rate-wise tax summary, no KOT layout, no way to reach a printer, "Checkout & Print" button in POS prints nothing. |
| GST on bills | DB stores per-line `tax_rate` + `tax_amount` and bill `tax_amount`; branch has `gstin`. Math is correct (tax-inclusive back-calc after discount allocation). **Receipt shows only a single "GST Amount"**: no CGST/SGST, no per-item tax, no taxable value, no rate summary, GSTIN optional. No IGST handling. |
| Frontend | No Kitchen/Bar pages. POS and Tables only know plain products. |

## 2. Requirements checklist

### Task 1 — Kitchen Menu
- [x] 1.1 Add / edit / delete (soft-delete) food products
- [x] 1.2 Fields: name, category, rate, description, availability (in stock / out of stock), GST %
- [x] 1.3 Rate editable any time
- [x] 1.4 Price history viewable
- [x] 1.5 Kitchen Menu page in the UI (admin/staff)

### Task 2 — Bar Menu with peg pricing
- [x] 2.1 Bar Menu page (alcoholic + non-alcoholic)
- [x] 2.2 Multiple serving sizes per drink (30/60/90 ml, full bottle) each with own fixed rate
- [x] 2.3 Rates easily editable and persisted (+ audit history)
- [x] 2.4 Peg sales deduct stock correctly (ml tracked against an "open bottle")
- [x] 2.5 Servings sellable from POS and from table KOT; bills/KOT carry the serving label

### Task 3 — Printer integration
- [x] 3.1 Review existing feature and report capabilities / limitations (section 1)
- [x] 3.2 KOT ticket (ESC/POS, text, HTML) per KOT order
- [x] 3.3 Customer bill (ESC/POS, text, HTML) per bill
- [x] 3.4 Per-branch printer config (host, port, paper width) and "send to network printer" endpoint
- [x] 3.5 Print buttons in UI (browser print of HTML as fallback when no network printer)

### Task 4 — GST-compliant billing
- [x] 4.1 Audit of bills (section 1)
- [x] 4.2 Receipt shows GSTIN, bill no/date, per-item rate, taxable value, CGST+SGST (or IGST), rate-wise summary, totals
- [x] 4.3 Item GST % honoured per product (override) with category fallback
- [x] 4.4 Unit tests for the GST split

## 3. Assumptions
1. Menu rates are **tax-inclusive** (same as MRP in the existing engine); GST is back-calculated.
2. Supply is intra-state by default -> CGST = SGST = tax/2. IGST used when the print request passes `interState=true`.
3. Kitchen items do not track stock (`trackStock=false`); bar items do.
4. Peg stock: a bottle is opened when needed. `stock.open_ml` holds ml left in the open bottle; the bottle counts leave `stock.quantity` when opened. Voiding restores ml.
5. "Delete" is a soft delete (`is_active=false`) because bills reference products.
6. Kitchen categories are free text (created on demand in `categories`, GST from the item).
7. Printers are ESC/POS network printers on raw TCP 9100; browsers cannot reach USB printers, so the HTML receipt + `window.print()` is the fallback.
8. Permissions: view = steward+, create/edit/delete/rates = manager+.

## 4. Data model changes (migration `0005_menu_servings_print`)
- `menu_type` enum (`RETAIL`, `KITCHEN`, `BAR`)
- `products`: `menu_type` (default RETAIL), `description`, `is_available` (default true), `gst_rate` (nullable override), `track_stock` (default true)
- `product_servings`: id, product_id, label, volume_ml (null = full bottle/unit), price, sort_order, is_active, unique (product_id,label)
- `serving_price_audit`: id, serving_id, user_id, old_price, new_price, changed_at
- `kot_items`, `bill_items`: `serving_id`, `serving_label`, `serving_ml` (snapshots)
- `stock`: `open_ml` (default 0); `stock_audit`: `change_ml` (default 0)
- `branches`: `printer_host`, `printer_port` (default 9100), `paper_width` (default `58mm`)

## 5. Implementation steps and files
1. **Schema + migration** — `src/db/schema.ts`, `drizzle/0005_*`
2. **Engines (pure, unit-tested)** — `modules/menu/serving.engine.ts` (ml deduct/restore), `modules/billing/gst.engine.ts` (CGST/SGST/IGST + rate summary), tests in `tests/unit/`
3. **Menu module** — `modules/menu/menu.service.ts`, `menu.routes.ts` (CRUD, servings, price history); register in `src/app.ts`; extend `listProducts` with servings
4. **Billing / KOT** — `billing.service.ts`, `billing.engine.ts` (mergeBillItems by product+serving), `kot.service.ts`, `kot.engine.ts`, `stock.engine.ts`
5. **Printing** — rewrite `src/lib/print/generator.ts` (bill + KOT, GST layout, HTML/text renderers), `src/lib/print/network.ts` (TCP sender), `modules/printing/print.routes.ts`, branch printer config endpoint
6. **Frontend** — `menu/MenuManager.tsx`, `menu/KitchenMenu.tsx`, `menu/BarMenu.tsx`, nav + routes, serving picker in `POS.tsx` and `Tables.tsx`, print buttons in `Bills.tsx` / `Tables.tsx`
7. **Tests** — integration test for menu + peg billing + void + receipt; run `npm test`
8. **Update this file** after each task; final report

## 6. Suggestions beyond the brief (not all implemented)
- Happy-hour / time-based rates; combo / peg-bundle pricing
- Recipe costing for kitchen items (ingredient stock deduction)
- Modifiers (extra cheese, no ice) with price deltas; table-side QR menu
- Peg pour variance report (expected ml vs. counted ml) for pilferage control
- Service charge line and round-off on bills; HSN codes on printed bills
- Printer health check + retry queue; cash-drawer kick on cash payment only
- Role-aware menu audit log (who changed which rate when) as a report page

## 7. Progress log

- **Task 1 — Kitchen Menu: done.** New `menu` module (`/api/v1/menu/kitchen`, `/menu/items/:id`, price history), new product columns (description, availability, per-item GST, `track_stock`), `KitchenMenu` page. Kitchen items bill without stock rows and use their own GST %. Tests: `tests/integration/menu.int.test.ts`.
- **Task 2 — Bar Menu / pegs: done.** `product_servings` + `serving_price_audit`; `PUT /menu/items/:id/servings` (edit, add, retire servings; every rate change audited); `BarMenu` page with 30/60/90 ml / bottle quick-adds and "add from catalog". Billing and KOT accept `servingId`, price from the serving, deduct **ml** from an open bottle (`stock.open_ml`), and void restores ml. POS has a serving picker; table KOT has a serving select.
- **Task 3 — Printing: done.** Finding: ESC/POS builder existed but was unused (details in section 1). Added KOT + bill documents (ESC/POS, text, HTML, JSON), `GET /print/bills/:id`, `GET /print/kot/:id`, `POST .../send` to a per-branch network printer (`printer_host/port`, `paper_width`, set via `PATCH /branches/:id`), and Print / Send buttons in POS, Bills and Tables. Tests: `tests/integration/print.int.test.ts` (incl. a real TCP socket).
- **Task 4 — GST bills: done.** Finding: DB had correct per-line tax but receipts showed one "GST Amount". New `gst.engine.ts`; receipts now show GSTIN, per-item taxable value and CGST/SGST (or IGST with `interState=true`), totals, and a rate-wise summary. Tests: `tests/unit/gst-serving-print.test.ts`.
- **Verification:** `tsc` (backend + frontend) clean, `vite build` ok, full `vitest` run: 42 files / 418 tests pass (existing 265 unit tests untouched). Playwright e2e (preview.html) not run; browser UI not clicked through.

## 8. Remaining gaps
- UI was type-checked and built but not exercised in a browser.
- Table checkout does not yet create a bill from a table session (pre-existing); the KOT print/serving work is in place for when it does.
- IGST is a request flag, not derived from customer GSTIN/state (no customer state data exists).
- Bills use the branch's saved GSTIN; no HSN codes or round-off line.
- Peg stock shows only as sealed bottles in the stock tab; open-bottle ml is not displayed yet.
- No UI for the branch printer settings (API only: `PATCH /branches/:id`).
- Menu is global across branches (same as products/MRP).

---

# Phase 2 — Close the gaps, make it a multi-tenant SaaS

Roles for the SaaS team (maps onto the existing role model, no new role enum):
- **Super Admin** = platform owner (role `owner`, no branch, no syndicate): the vendor team. Manages tenants (bar businesses), plans, suspension, sees usage.
- **Admin** = tenant owner (role `owner` with a `syndicateId`): the bar owner. Manages branches, printer/GST settings, staff, menu, reports for their own business only.
- manager / cashier / steward unchanged.

## Checklist
- [x] G1 Branch printer settings screen (+ test print, GSTIN, paper width, round-off)
- [x] G2 Table checkout creates a bill from the table's KOT items (servings, GST, print), closes table, idempotent
- [x] G3 IGST derived from buyer GSTIN state vs branch GSTIN state (customer + bill `customer_gstin`)
- [x] G4 HSN code on items and printed bills; round-off line stored on the bill and posted to the books
- [x] G5 Stock tab shows open-bottle ml
- [x] G6 Menu per tenant (`products.syndicate_id`) + per-branch availability override
- [x] S1 Super Admin console: tenants list/stats, create tenant + first admin, plan & branch limit, suspend/activate (enforced at login and every request)
- [x] S2 Admin console: branches (create/edit within plan limit), settings, staff
- [x] S3 Owner branch switcher (owners have no branch; all pages use the active branch) + grouped navigation by role
- [x] N1 Pour-variance: record pour counts, variance report with value, page
- [x] N2 Playwright e2e for the React app (Kitchen, Bar/peg POS, table checkout, printer settings, super admin) + browser click-through
- [x] N3 Full test run, final report

## Assumptions
1. Super Admin / Admin are the platform-owner / syndicate-owner roles that already exist.
2. Buyer state is the first two digits of GSTIN; no buyer GSTIN = intra-state B2C.
3. Round-off is opt-in per branch, applied to the bill total only (tax is computed before rounding); the difference is posted to a new `ROUND_OFF` ledger so books still balance.
4. Plan limits: TRIAL 1 branch, STANDARD 3, PRO 25 (editable per tenant by Super Admin as `maxBranches`).
5. Existing retail products keep `syndicate_id = NULL` (shared catalog); only menu items created from now on are tenant-owned.

## Progress log (phase 2)

- **G1 Printer settings screen — done.** `/settings` (Admin): branches table, edit modal with GSTIN, printer host/port, paper width, round-off, "Save & send test ticket" (`POST /print/test/:branchId`). E2E sends a real test ticket to a local TCP printer.
- **G2 Table checkout — done.** `POST /tables/:tableId/checkout` bills every non-cancelled KOT item (servings, per-item GST, peg ml, accounting) through `createBill`, links the session, frees the table; idempotent via `clientRef = table-session:<id>`. Tables screen: "Checkout & bill" modal with payment, discount, buyer GSTIN, Print / Send to printer.
- **G3 IGST — done.** `customers.gstin`, `bills.customer_gstin`; receipt uses IGST when the buyer's GSTIN state code differs from the branch's (`interState=` query still overrides).
- **G4 HSN + round-off — done.** `products.hsn_code` on the menu form and receipts. Round-off is per-branch opt-in, stored in `bills.round_off`, shown on the receipt, posted to a new `ROUND_OFF` ledger (vouchers still balance; void reverses it).
- **G5 Open-bottle ml — done.** Stock tab shows "+N ml open".
- **G6 Menu per tenant — done.** `products.syndicate_id` scopes menu items and the product list to the tenant; billing/KOT reject another tenant's items; per-branch availability override (`branch_menu_availability`), switched from the menu pill for the branch being worked in.
- **S1 Super Admin console — done.** `/platform`: tenant list with plan, branches used/limit, staff, 30-day sales, admins; add tenant + first Admin; change plan/limit; suspend/reactivate (login and every request blocked for the whole tenant).
- **S2 Admin console — done.** Business Settings (plan usage, branch add/edit within the plan limit) + existing Staff & Terminals.
- **S3 Branch switcher and grouped navigation — done.** Owners work in a chosen branch (header selector); sidebar grouped Overview / Sell / Menu & Stock / Money & Compliance / Business / Platform and filtered by role (Super Admin sees only Platform).
- **N1 Pour variance — done.** `pour_counts`, record count (adjusts the open-bottle ml and the audit trail), variance report (pegs, ml, % of sold, value at the bottle rate), `/pour` page.
- **N2 Playwright for the React app — done.** `tests/e2e/react-saas.spec.ts` (6 journeys). Found and fixed a real bug along the way: the frontend API client sent `Content-Type: json` with empty bodies, so every body-less POST/DELETE (Delete menu item, Send to printer, Test print) got a 400.
- **N3 Verification:** backend `tsc` clean; frontend `tsc -b` + `vite build` ok; Vitest 43 files / 433 tests pass; Playwright 27/27 pass (21 existing + 6 new). `shift-lifecycle.spec.ts` was already failing on the untouched commit (its "Old Monk" search matched a 375 ml product first); it now searches "Old Monk XXX".

# Phase 3 — Closing the remaining gaps

## Checklist
- [x] R1 Tenant-scoped catalog: products own a tenant; barcode/SKU unique per tenant; barcode scan, product list, invoice matching, billing, KOT and adoption are all tenant-scoped (categories stay a shared taxonomy by design: name + GST rate only)
- [x] R2 Subscription billing back office: plan prices, 14-day trial, invoices, record payment, access rule (trial end / paid-until + 7 day grace) enforced at login and on every request
- [x] R3 Passwords: change own password; managers/Admin reset staff; Super Admin resets a tenant Admin (temporary password shown once)
- [x] R4 Support sign-in (30 minute token, banner + exit) and an audit log
- [x] R5 Buyer GSTIN on POS and the Customers form
- [x] R6 Print queue with retry/backoff (server worker), `?queue=true` on auto-prints, Retry from Business Settings
- [x] R7 Round-off per bill (override of the branch default), choice on table checkout
- [x] R8 Existing tenants: branch limit follows the plan (never below branches in use), trial/paid dates set so nobody is locked out by the upgrade, single-tenant catalogs assigned to that tenant

## Assumptions
1. There is no payment gateway: the Super Admin records payments received by bank transfer / UPI / cheque (reference required). A gateway would call the same "mark paid" path.
2. No e-mail service: password resets hand a temporary password to the person who asked (shown once, audited).
3. Categories are a shared taxonomy (name + GST %); everything with a price, barcode, stock or sales is tenant-scoped.
4. Prices: Trial free, Standard ₹2,999, Pro ₹7,999 per month incl. GST (constants in platform.service.ts).

## Progress log (phase 3)
- Migration `0007_tenant_catalog_billing_audit_print` (tables: subscription_invoices, audit_log, print_jobs; products unique indexes per tenant; data fixes for existing rows).
- Found while testing in the browser: a hard page reload on any React page logged the user out (the session check ran after the first render). Fixed with a loading state.
- Tests: Vitest 45 files / 452 tests, Playwright 30 journeys (21 original + 9 React) all pass; `tsc` (both projects) and `vite build` clean.

## Superseded by phase 4
The items listed as open above (payment gateway, billing reminders, forgot password, USB/Bluetooth printing) are done in phase 4.

---

# Phase 4 — Payment gateway and the remaining functionality

All external values live in `.env` (template in `.env.example`, walkthrough in `INTEGRATIONS.md`); the app runs without any of them
(built-in test gateway, e-mail stored in an outbox) and the Super Admin console shows what is still missing.

## Checklist
- [x] P1 Payment gateway: Razorpay (order, browser checkout, signature verification, webhook with raw-body HMAC) behind a provider interface; built-in test gateway with the same flow
- [x] P2 Self-service billing: Pay now, Renew early, Choose plan (paying switches the plan), invoices list, billing banner
- [x] P3 Locked tenants (trial ended / overdue) can sign in and reach only the payment screen; suspended tenants stay blocked
- [x] P4 Billing job: renewal invoice a week ahead, e-mail reminders (once each), Run now button
- [x] P5 E-mail: SMTP via nodemailer, every message recorded in email_outbox (Super Admin can read them)
- [x] P6 Forgot password: e-mailed single-use hashed token (1 hour), throttled, no account probing
- [x] P7 Local print agent (print-agent/): Windows printer, Windows share, COM/Bluetooth/USB device file, CUPS command, LAN TCP; per-branch token; pull-based jobs with claim/ack/retry
- [x] P8 Integrations status + outbox in the Platform Console; support can extend a trial / paid period by hand
- [x] P9 Tests (unit, integration, Playwright) for all of the above

## Assumptions
1. Razorpay is the gateway (INR, UPI, cards, netbanking). Another provider only needs a new class implementing PaymentGateway.
2. Choosing a plan raises its invoice; the tenant moves to that plan when the invoice is paid, so choosing never grants free days.
3. A webhook for an unknown order is acknowledged (200) and ignored; invalid signatures get 400.
4. The print agent talks to the server over HTTPS only (outbound), authenticated by a per-branch secret that is stored hashed.

## Progress log (phase 4)
- Migration `0008_payments_mail_reset_dunning_agent`: payment_orders, email_outbox, password_resets, dunning_log, print_jobs.target/payload/claimed_at, branches agent columns.
- Bugs found by the tests and fixed: empty env values were treated as set (`??` vs `||`) so SMTP on port 465 was not secure; a locked tenant's plan switch used to grant grace days.
- Tests: Vitest 47 files / 489 tests, Playwright 35 journeys, `tsc` (both) and `vite build` clean.

## Still open
- Razorpay live mode and SMTP are untested against the real services (no credentials): the request/signature code is covered with stubs and the documented HMAC scheme.
- Windows raw-printing PowerShell path in the agent could not be run here (no Windows printer attached); the file, TCP, command and stdout paths are tested.
