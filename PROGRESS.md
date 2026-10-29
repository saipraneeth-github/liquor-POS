# PROGRESS.md -- where we are and how to resume

> Living handoff file. Update it at the end of every work session. Read `AGENTS.md` for the project itself.
> Last updated: 2026-10-26 (IST)

## TL;DR

- **All phases (1-6) complete and verified (2026-10-25).** `tsc --noEmit` clean, Vitest **357/357** (37 files: 230 unit + 127 integration), Playwright **21/21** (12 spec files).
- **Finished:**
  - Phases 1-5 + UI & layout polish across all 14 screens (cleaned polluted `.pglite` XSS test records, hardened backend entity-name schemas against `<`/`>`, fixed Dashboard KPI grid/spacing/quick-actions, fixed `.two-col` track sizing & `min-width: 0`, fixed Customers table clipping, POS card alignment & sticky bill panel, Shift & filter bar alignment, and Sidebar layout).
  - Phase 6 -- Supplier invoice upload & workflow (`src/modules/invoices/**`, migration `0002_invoice_upload.sql`, unit tests `tests/unit/invoices.engines.test.ts`, integration tests `tests/integration/invoices.int.test.ts`, Inventory -> Supplier invoices UI in `preview.html`, and Playwright E2E `tests/e2e/supplier-invoices.spec.ts`).
- **Not committed/pushed yet.** The user decides when to commit and push.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Syndicates & multi-tenancy (platform / syndicate owner / branch users), users & branches admin, page-permission guard, consolidated syndicate invoices, pack-quantity (cases ↔ bottles) | ✅ done + independently reviewed |
| -- | Core bug fixes: cross-branch void, race-free stock/void/bill numbers (`bill_counters`), category tax rates, GST after discount, CREDIT sales, `clientRef` idempotency, shift linking, bill history API, domain events, atomic invoice approval, token re-validation per request | ✅ done + reviewed |
| 2 | Terminals, cashier shifts with denomination count & discrepancy, daily counter sheets (Opening + Inward - Closing = Sold) | ✅ done + reviewed |
| 3 | Customer khata (credit, repayments, statements, outstanding), scheme slabs & payout, excise quotas & lifting report, breakage, stock-audit report | ✅ done + reviewed |
| 4 | Double-entry accounting (auto-posting via domain events), expenses, manual journals, trial balance, P&L, balance sheet, Tally XML export | ✅ done + reviewed |
| 5 | Web UI for all modules, owner branch picker, role-aware nav, offline bill queue + sync, UI & layout polish across all screens | ✅ done + verified |
| 6 | Supplier invoice upload (local CSV/XLSX/PDF/OCR) + draft -> review -> approve/reject + history + UI + unit/integration/e2e tests | ✅ done + verified |

## In flight right now

A background agent is doing Phase 5. Its brief:
1. Audit & fix existing UI bugs (console errors, wrong API paths, 400px layout, quick-login map).
2. Owner branch picker (`GET /branches`), role-aware navigation, 401/403 handling.
3. Screens: shift open/close, bill history + void, khata + CREDIT at POS, counter sheet, inventory/breakage,
   schemes, compliance, accounting (+ Tally download), admin (users, terminals, branches).
4. Offline billing: queue failed `POST /bills` in localStorage with `clientRef`, auto-sync on reconnect.
5. New e2e specs (owner closes day, shift lifecycle, credit + repayment, void, counter sheet, offline sync,
   trial balance, role gating) and get `npx playwright test` fully green.

Progress seen: 23:29 markup rewritten; 23:42 JavaScript written (`preview.html` ~2,944 lines). Not yet: e2e specs.
2026-10-25: the agent stalled once (no output for 10 min) before the per-role audit; resumed with instructions
to work in small edits and append status notes here after each step.
- Step 1 done: per-role Playwright audit (owner/manager/cashier/steward, 1280px + 400px) -- no console errors,
  no 4xx, no horizontal overflow. Backend: additive read projections (products -> categoryName/taxRate;
  tables -> currentSessionId) + `tests/integration/ui-projections.int.test.ts`. Journey 4 spec updated for role nav.
- Step 2 done: all 7 existing e2e journeys pass (fixed a bootstrap race where showPage('dashboard') ran after the
  catalog load and overrode an early nav click). Next: new spec files one at a time.
- Step 3 in progress: added tests/e2e/helpers.ts + owner-branch-closing, shift-lifecycle, credit-khata,
  void-bill, counter-sheet specs (each passing alone). Remaining: offline-billing, accounting, role-gating.
- Step 3/4 done: + offline-billing and accounting-and-roles specs. Final: playwright 17/17 passed (twice),
  vitest 338 passed (35 files), tsc clean. Phase 5 complete pending review/commit approval.
- 2026-10-25 UI review fixer done (20 confirmed findings + steward table service). preview.html: per-user offline queue
  (`lc_offline_bills:<sub>`, ownerSub on items, legacy-key migration, logout warns about unsynced bills, pending-sync block on
  Bills, late-business-day warning, table bills refused offline); occupied table tile opens an actions dialog (close without
  billing warns + confirms); taxable = total - GST; ledger/table caches cleared on branch switch/logout; dashboard pages
  through all bills; credit-limit warning live; KOT status shows only allowed moves; Day Closing has no prefilled cash and
  confirms; modal focus trap + inert background; phone drawer inert; POS mobile summary bar; inline field errors; accounting
  tabs keyboard/ARIA; dark-theme table CTA contrast. Backend: `GET /tables/:branchId` and `GET /products` now steward+
  (products omit costPrice for stewards). Tests: ui-projections.int (+2), steward-tables.spec (2), offline cross-user spec,
  specs updated for closing confirm / table actions. Final: tsc clean, vitest 340/340 (35 files), playwright 20/20 (twice).

**If the session ended before it reported back**, resume like this:
1. `git diff --stat` -- see what the agent changed (expect `preview.html`, maybe `tests/e2e/*`).
2. `npx tsc --noEmit` and `npx vitest run` -- must still be clean / 336+ passing.
3. Kill anything on port 3001, then `npx playwright test --reporter=line`.
4. Continue the Phase 5 brief above from whatever is missing/failing. Baseline before the rewrite:
   6/7 old journeys passed; Journey 6 (owner day closing) failed only because the owner had no branch picker.

**UI review (2026-10-25, workflow `ui-review`, run id `wf_16711a5e-341`).** If interrupted, resume with
`Workflow({scriptPath: <session workflows dir>/ui-review-wf_16711a5e-341.js, resumeFromRunId: 'wf_16711a5e-341'})`
or, in a new session, simply re-run the review: 3 lenses -> verify -> one fixer -> tsc/vitest/playwright.

## Next: supplier invoice upload + workflow (approved by user 2026-10-25, starts after the UI review)

Gap found: invoices are manual-entry only (`/inventory/invoices/parse` just validates typed JSON); no history; one-step
approval although the schema has DRAFT/REVIEWED/APPROVED/REJECTED. User chose: **CSV/Excel + PDF/photo (Claude)**
upload and **history + draft -> review -> approve/reject**.

Design:
- `POST /inventory/invoices/upload` (multipart, cashier+, ≤10 MB). **All extraction is local -- no API key, no cost**
  (user decision 2026-10-25). Libraries installed (pinned): `@fastify/multipart` 10.1.3, `papaparse` 5.7.0 (CSV),
  `exceljs` 4.4.0 (XLSX), `pdfjs-dist` 6.4.299 (text PDFs, with x/y positions to rebuild table rows),
  `tesseract.js` 7.0.0 + `@tesseract.js-data/eng` (offline OCR for JPG/PNG and scanned PDFs),
  `@napi-rs/canvas` 1.0.11 (render scanned PDF pages for OCR). Spike (scratchpad/spike/ocr-spike*.mjs): PDF text exact
  in ~0.1 s; OCR offline ~1 s/page -- best with the `4.0.0` model, 2�-- upscale, `tessedit_pageseg_mode=6`; it still
  misreads some digits (e.g. 3960->3360), so: per-line qty�--rate vs amount check, lines-sum vs total check, catalog
  fuzzy matching (barcode -> SKU -> name tokens), MRP vs catalog check, flagged lines highlighted, always lands as DRAFT.
  Lines matched to catalog; unmatched lines kept for review. Original file stored in the DB.
- Draft CRUD (cashier+): create manual draft, edit header/lines/product mapping while DRAFT.
- `review` / `approve` / `reject {reason}` (manager+). Approve reuses the existing atomic approval (stock + stock_audit
  PURCHASE, price_audit, scheme progress, `supplierInvoice.approved` -> accounting voucher). Existing direct
  `/inventory/invoices/approve` kept for compatibility.
- History: list by status/date/supplier/search, detail, original-file download.
- **Status 2026-10-25:** backend running in parallel with the UI review as workflow `invoice-upload-backend`
  (run id `wf_3d8e41bc-38b`: build -> 2 independent reviewers (accuracy/money, security) -> fixer). New module
  `src/modules/invoices/`, migration `0002_invoice_upload`. Resume with `resumeFromRunId` if interrupted.
- UI (after both workflows finish): Inventory -> Supplier invoices: upload, review grid with match status, approve/reject, history. E2E with CSV
  (PDF path tested with a mocked extractor; no API key needed for tests).

## Remaining after Phase 5

1. Independent review of the UI changes (fresh reviewer, fix findings) -- **running**.
2. Final full verification: `npx tsc --noEmit`, `npx vitest run`, `npx playwright test`.
3. Ask the user for approval, then commit in logical chunks (suggested):
   - `chore: remove reverse-engineering scratch files and plan doc; add AGENTS.md/CLAUDE.md`
   - `feat(db): PGlite support, migrate script, phase 2-4 schema + migration 0001`
   - `fix(core): tenancy, billing races/tax/credit/idempotency, domain events`
   - `feat: phases 2-4 modules (shifts, counter sheets, khata, compliance, accounting)`
   - `feat(ui): phase 5 web UI + offline billing` and `test(e2e): …`

## Open items / decisions (not blocking)

- Duplicate same-day closings are still allowed (existing e2e closes the same day repeatedly); consider
  a unique `(branch_id, closing_date)` once the tests are adjusted.
- Closing uses bill creation date; voiding a bill from an already-closed day isn't reflected in that closing.
- Product MRP is global, not per branch.
- Scheme slab payout: "best slab" rule, ignores dates, assumes qty in cases; slabs editable on closed schemes.
- Accounting: periodic inventory (no closing-stock entry); void vouchers lack `createdById`; voiding a bill
  paid before accounting was enabled posts a reversal of an unrecorded sale.
- Category GST rates in the seed are all 18% -- confirm real rates with the business (liquor is largely
  under state excise/VAT, not GST).
- Concurrency tests run on PGlite (serialised); run the integration suite against real Postgres before production.
- `.agents/` folder and `README.md` describe generic AI tooling, not this app -- candidates for removal/rewrite.

## Key facts for whoever resumes

- Run locally with no Postgres: `npm run dev:local` -> http://localhost:3001 (data in `./.pglite`).
- Logins (password `Password@123`): `owner@` (syndicate owner, must pick branch), `manager@`, `cashier@`,
  `steward@liquor.com`.
- E2E boots its own fresh DB (`./.pglite-e2e`); Chromium is installed (`npx playwright install chromium` on a new machine).
- Schema change workflow: edit `src/db/schema.ts` -> `$env:DATABASE_URL='postgresql://x:x@localhost:5432/x'; npx drizzle-kit generate --name <name>`.
  Migration `0001_phases_2_to_4` is unreleased, so it was regenerated in place; after the first commit, always add new migrations instead.
- The Zambient reverse-engineering material was intentionally deleted at the user's request -- don't restore it.

## Session log

- **2026-10-24** -- Reviewed project; wrote `AGENTS.md`; removed reverse-engineering files. User merged PR #2.
  Added PGlite driver, migrate script, integration harness, full phase 2-4 schema. Ran build workflow:
  core + phases 2/3/4 implemented, 4 independent reviewers fixed 21 more defects. Applied follow-ups
  (constraints, repayment idempotency, 500 for DB errors, IST business day, shift lock). Wired routes.
  336 tests green. Started Phase 5 UI agent.

- **2026-10-25** -- Phase 5 UI finished + independent UI review (20 fixes). Invoice-upload backend started in parallel (local libs, no API key); stopped mid-build at the user's request. Tally export confirmed done (gaps: ledger masters, direct sync, item-level GST). All work committed locally.

- **2026-10-26** -- Bug fixes & stabilization:
  - Resolved PGlite wasm/memory hook timeout during integration tests on Windows by configuring serial file execution (`--fileParallelism=false`, `hookTimeout: 120_000`).
  - Added duplicate same-day closing check in `closing.service.ts` throwing 409 ConflictError when a branch day closing has already been posted for that business date. Added migration `0003_unique_daily_closing.sql`.
  - Added active-status enforcement in `scheme.service.ts` preventing slab changes on non-ACTIVE schemes (COMPLETED/EXPIRED/CANCELLED), with integration test.
  - Fixed E2E rate-limit 429 errors by restricting `/auth/login` rate limiting to production environments only in `auth.routes.ts`.
  - Verified green across full stack: `npm run build` clean, Vitest **357/357** passed (37 files), Playwright **21/21** passed (12 spec files).

- **2026-10-29** -- Full React 19 SPA Port with `preview.html` preservation:
  - Ported all remaining screens from `preview.html` into modern React 19 + TypeScript components in `frontend/src/`:
    - `dashboard/Dashboard.tsx` (KPI stats, time-of-day greeting, recent bills, steward guide)
    - `customers/Customers.tsx` (Khata, credit statements, repayments, clientRef idempotency, credit settings)
    - `counter/Counter.tsx` (Daily counter sheet, opening/inward/closing/sold math, manager post sheet)
    - `shifts/Shift.tsx` (Terminal shift open, live collections, denomination count grid, shortage/excess discrepancy calculation, shift close & summary)
    - `products/Products.tsx` (Catalog, search, manager new product drawer, live MRP edit modal)
    - `inventory/Inventory.tsx` (Stock levels, breakage recording & logs, supplier invoice upload/edit/review/approval workflow)
    - `closing/Closing.tsx` (Daily register closing, cash counting, withdrawals, discrepancy, closing history)
    - `schemes/Schemes.tsx` (Supplier schemes, progress tracking, purchase logging, slab management)
    - `compliance/Compliance.tsx` (Excise quotas, lifting reports, breakage logs, stock audit history)
    - `admin/Admin.tsx` (User management, terminal management, page permissions)
    - Updated `App.tsx`, `Layout.tsx`, `client.ts` (added `put` and `delete`), and route bindings.
  - Preserved `preview.html` 100% intact as source-of-truth and backup at `/preview`.
  - Full verification: `npm run build` passed (0 errors, Vite bundle 2.7s), Vitest **357/357** passed (24 unit test files, 13 integration test files), Playwright E2E **21/21** passed (12 spec files).
