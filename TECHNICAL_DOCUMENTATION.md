# Liquor Counter POS — Full-Scale Technical Documentation

**Version:** 1.0.0  
**Last Updated:** 2026-10-25  
**Target Domain:** Retail Liquor Counters, Bars & Multi-Store Syndicates (India)

---

## Table of Contents

1. [System Overview & Domain Invariants](#1-system-overview--domain-invariants)
2. [System Architecture & Design Patterns](#2-system-architecture--design-patterns)
3. [Technology Stack & Dependencies](#3-technology-stack--dependencies)
4. [Multi-Tenancy, Authentication & RBAC](#4-multi-tenancy-authentication--rbac)
5. [Database Schema & Persistence Model](#5-database-schema--persistence-model)
6. [Core Domain Engines & Business Algorithms](#6-core-domain-engines--business-algorithms)
   - [6.1 POS Billing & Post-Discount GST Engine](#61-pos-billing--post-discount-gst-engine)
   - [6.2 Cashier Shifts & Daily Counter Sheets](#62-cashier-shifts--daily-counter-sheets)
   - [6.3 Supplier Invoice Extraction, Matching & Workflow Engine](#63-supplier-invoice-extraction-matching--workflow-engine)
   - [6.4 Inventory, Reorder Indent & Excise Compliance](#64-inventory-reorder-indent--excise-compliance)
   - [6.5 Customer Khata (Credit) & Supplier Schemes](#65-customer-khata-credit--supplier-schemes)
   - [6.6 Bar Table Sessions & KOT State Machine](#66-bar-table-sessions--kot-state-machine)
   - [6.7 Double-Entry Accounting & Tally XML Exporter](#67-double-entry-accounting--tally-xml-exporter)
7. [Complete REST API Specification (`/api/v1`)](#7-complete-rest-api-specification-apiv1)
8. [Frontend Architecture (`preview.html`)](#8-frontend-architecture-previewhtml)
9. [Concurrency, Security & Data Integrity Controls](#9-concurrency-security--data-integrity-controls)
10. [Testing & Verification Architecture](#10-testing--verification-architecture)
11. [Deployment, Configuration & Operations](#11-deployment-configuration--operations)

---

## 1. System Overview & Domain Invariants

**Liquor Counter POS** is an end-to-end point-of-sale, inventory, excise compliance, and double-entry accounting system purpose-built for Indian retail liquor shops, bar-cum-restaurants, and multi-branch liquor syndicates.

### Fundamental Domain Invariants

1. **Tax-Inclusive MRP Authority:**
   - Retail liquor in India is sold at Maximum Retail Price (**MRP**), which is tax-inclusive and cannot be overridden at the billing counter.
   - `POST /api/v1/bills` accepts only `{ productId, quantity }` per line; unit prices and tax rates are always fetched from the database (`products.mrp`, `categories.tax_rate`).
2. **Post-Discount GST Back-Calculation:**
   - Bill-level discount is allocated proportionally across line items by gross line value (with rounding remainder applied to the largest line).
   - GST is back-calculated from each line's net post-discount amount:
     $$\text{Taxable} = \frac{\text{Net}}{1 + \frac{\text{Rate}}{100}}, \quad \text{Tax} = \text{Net} - \text{Taxable}$$
3. **Exact Decimal Arithmetic:**
   - All monetary values are stored as `numeric(12,2)` or `numeric(14,2)` in PostgreSQL, transmitted as decimal strings (`"1050.00"`), and computed using `decimal.js` on the server and integer paise on the client. Native IEEE-754 floating-point math is never used for money.
4. **Immutable Bills & Append-Only Audit Trails:**
   - Paid bills are never deleted or mutated in place; they can only be **voided** (`POST /api/v1/bills/:id/void`, manager+ with mandatory reason), which atomically reverses stock, reverses customer khata balance, and posts a reversing journal voucher.
   - Every stock movement writes an append-only row to `stock_audit` (`SALE`, `PURCHASE`, `VOID_REVERSAL`, `BREAKAGE`, `COUNTER_SHEET`, `MANUAL_ADJUST`, `DAMAGE`, `SCHEME_FREE_GOODS`).
   - Every MRP change writes an append-only row to `price_audit` (`old_mrp`, `new_mrp`, `user_id`, `changed_at`).
5. **Transactional Double-Entry Accounting:**
   - Every financial business event (`bill.paid`, `bill.voided`, `supplierInvoice.approved`, `credit.repayment`, `expense.recorded`) emits a typed domain event **inside the same database transaction**.
   - The accounting subscriber posts a balanced journal voucher (`sum(debit) == sum(credit)`) in that transaction; if voucher posting fails, the entire business operation rolls back.
6. **Local Business Day (IST):**
   - Business dates (`YYYY-MM-DD`) are computed using `BUSINESS_UTC_OFFSET_MINUTES` (default `330` = UTC+05:30 IST), ensuring late-night sales before midnight IST are grouped into the correct store calendar day regardless of server OS timezone.

---

## 2. System Architecture & Design Patterns

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Browser SPA (preview.html)                            │
│  Role-Aware Nav · POS Cart · Per-User Offline Queue (localStorage) · A11y    │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ HTTPS / JSON + Multipart (/api/v1/*)
┌──────────────────────────────────────▼───────────────────────────────────────┐
│                         Fastify 5 HTTP Layer                                 │
│  @fastify/helmet · @fastify/cors · @fastify/jwt · @fastify/multipart         │
│  Auth Guard (requireRole + live DB user re-read + assertBranchAccess)        │
└──────────┬───────────────────────────┬───────────────────────────┬───────────┘
           │                           │                           │
┌──────────▼──────────┐     ┌──────────▼──────────┐     ┌──────────▼──────────┐
│  *.routes.ts        │     │  *.service.ts       │     │  *.engine.ts        │
│  Zod validation     │────▶│  db.transaction()   │────▶│  PURE TypeScript    │
│  RBAC + branch guard│     │  Row locks & SQL    │     │  Zero I/O, Decimal  │
│  HTTP status mapping│     │  emitDomainEvent()  │     │  Unit-tested        │
└─────────────────────┘     └──────────┬──────────┘     └─────────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │  Domain Event Bus   │
                            │  (In-Transaction)   │
                            │  posting.service.ts │
                            └──────────┬──────────┘
                                       │
                            ┌──────────▼──────────┐
                            │  Drizzle ORM Client │
                            │  Postgres / PGlite  │
                            └─────────────────────┘
```

### Strict 3-Layer Module Split

Every domain module under `src/modules/<domain>/` follows a strict separation of concerns:

| Layer | File Pattern | Responsibility |
|---|---|---|
| **Engine** | `<domain>.engine.ts` | **100% pure business logic.** No database imports, no HTTP/Fastify types, no I/O. Takes typed data structures and returns deterministic outputs using `decimal.js`. Directly unit-tested in `tests/unit/`. |
| **Service** | `<domain>.service.ts` | **Transactional orchestration & persistence.** Defines Zod input schemas, opens `db.transaction(async (tx) => ...)`, acquires row locks (`FOR UPDATE` / `FOR SHARE`), invokes pure engines, writes audit rows, and emits domain events. |
| **Routes** | `<domain>.routes.ts` | **HTTP boundary.** Enforces authentication and role guards (`requireRole`), verifies multi-tenant branch access (`await assertBranchAccess(...)`), parses params/query/body with `safeParse`, and maps domain errors (`NotFoundError` → 404, `ForbiddenError` → 403, `ConflictError` → 409, `BusinessRuleError` → 422) via `sendError()`. |

---

## 3. Technology Stack & Dependencies

| Category | Package / Version | Purpose |
|---|---|---|
| **Runtime & Language** | Node.js 22+, TypeScript 5.6 (`strict: true`, `NodeNext` ESM) | Type-safe server execution |
| **Web Framework** | `fastify` 5.0, `@fastify/jwt` 9.0, `@fastify/cors` 10.0, `@fastify/helmet` 12.0, `@fastify/multipart` 10.1 | HTTP server, security headers, JWT auth, file uploads |
| **ORM & Database** | `drizzle-orm` 0.36, `drizzle-kit` 0.28, `postgres` 3.4, `@electric-sql/pglite` 0.2.12 | Dual-driver SQL access: production PostgreSQL or embedded PGlite (`pglite://./.pglite` / `pglite://memory`) |
| **Precision Math** | `decimal.js` 10.4 | Arbitrary-precision decimal arithmetic for currency, tax, and case conversions |
| **Validation & Auth** | `zod` 3.23, `bcryptjs` 2.4 | Request schema validation and password hashing |
| **Document Extraction** | `papaparse` 5.7 (CSV), `exceljs` 4.4 (XLSX), `pdfjs-dist` 6.4 (PDF text layer), `tesseract.js` 7.0 + `@tesseract.js-data/eng` (offline OCR), `@napi-rs/canvas` 1.0 (PDF page rendering & image upscaling) | 100% local, zero-API-cost supplier invoice extraction |
| **Testing** | `vitest` 2.1 (unit + integration), `@playwright/test` 1.59 (E2E browser tests) | Automated verification across all layers |

---

## 4. Multi-Tenancy, Authentication & RBAC

### 4.1 Role Hierarchy

Roles are ordered by numeric rank in `src/middleware/auth.guard.ts`:

```
steward (1) < cashier (2) < manager (3) < owner (4)
```

- `requireRole(minRole)` verifies the JWT signature and **re-reads the user row (`id, role, branchId, syndicateId, isActive`) from the database on every request**.
- If a user is deactivated (`isActive = false`) or demoted by an administrator, their existing JWT is rejected (`401` / `403`) on the very next API call without waiting for token expiry.

### 4.2 Multi-Tenant Branch Scope

| Actor Type | DB Representation | Accessible Branches (`getAccessibleBranchIds`) |
|---|---|---|
| **Platform Owner** | `role = 'owner'`, `branchId = NULL`, `syndicateId = NULL` | `'ALL'` (every branch across all syndicates) |
| **Syndicate Owner** | `role = 'owner'`, `branchId = NULL`, `syndicateId = <uuid>` | All branches where `branches.syndicate_id = user.syndicateId` |
| **Branch Staff** (`manager`, `cashier`, `steward`) | `branchId = <uuid>` | `[user.branchId]` only |

Every branch-scoped endpoint calls `if (!(await assertBranchAccess(user, branchId, reply))) return;` before executing any query or mutation.

### 4.3 Optional Page-Permission Matrix

- Table `user_page_permissions` (`user_id`, `route_path`, `can_access`) allows managers/owners to grant or revoke specific functional areas (`dashboard`, `pos`, `bills`, `tables`, `inventory`, `purchases`, `customers`, `schemes`, `closing`, `reports`, `accounting`, `settings`) per user.
- Owners bypass page restrictions automatically.

---

## 5. Database Schema & Persistence Model

All tables and enums are defined in `src/db/schema.ts` and managed via SQL migrations in `drizzle/` (`0000_nervous_barracuda.sql`, `0001_phases_2_to_4.sql`, `0002_invoice_upload.sql`).

### 5.1 Tenancy & Users
- **`syndicates`**: `id (PK)`, `name`, `gstin`, `pan`, `contact_phone`, `is_active`, `created_at`
- **`branches`**: `id (PK)`, `syndicate_id (FK)`, `parent_branch_id (self-FK)`, `name`, `code (UNIQUE)`, `address`, `gstin`, `excise_license_no`, `created_at`
- **`users`**: `id (PK)`, `branch_id (FK)`, `syndicate_id (FK)`, `name`, `email (UNIQUE)`, `password_hash`, `role (enum)`, `is_active`, `created_at`
- **`user_page_permissions`**: `id (PK)`, `user_id (FK cascade)`, `route_path`, `can_access`, `UNIQUE(user_id, route_path)`
- **`consolidated_invoices`**: `id (PK)`, `syndicate_id (FK)`, `period_start`, `period_end`, `gross_sales`, `total_tax`, `bill_count`, `breakdown (jsonb)`, `created_by_id (FK)`, `created_at`

### 5.2 Product Catalog & Stock
- **`categories`**: `id (PK)`, `name (UNIQUE)`, `tax_rate numeric(5,2)`
- **`products`**: `id (PK)`, `category_id (FK)`, `barcode (UNIQUE)`, `sku (UNIQUE)`, `name`, `brand`, `volume_ml`, `excise_code`, `pack_quantity`, `mrp numeric(12,2)`, `cost_price numeric(12,2)`, `is_active`, `created_at`
- **`price_audit`**: `id (PK)`, `product_id (FK)`, `user_id (FK)`, `old_mrp`, `new_mrp`, `changed_at`
- **`stock`**: `id (PK)`, `branch_id (FK)`, `product_id (FK)`, `quantity integer`, `reorder_level integer`, `UNIQUE(branch_id, product_id)`
- **`stock_audit`**: `id (PK)`, `branch_id (FK)`, `product_id (FK)`, `user_id (FK)`, `change_qty integer`, `reason (enum)`, `reference_id`, `created_at`

### 5.3 Counter Billing, Registers & Shifts
- **`terminals`**: `id (PK)`, `branch_id (FK)`, `terminal_name`, `device_key (UNIQUE)`, `is_active`, `UNIQUE(branch_id, terminal_name)`
- **`shift_sessions`**: `id (PK)`, `branch_id (FK)`, `terminal_id (FK)`, `cashier_id (FK)`, `status ('OPEN'|'CLOSED')`, `opened_at`, `closed_at`, `opening_float`, `expected_cash`, `counted_cash`, `cash_collected`, `upi_collected`, `card_collected`, `credit_collected`, `denominations (jsonb)`, `discrepancy`, `notes`
  - Partial unique indexes: `uq_open_shift_cashier ON (cashier_id) WHERE status = 'OPEN'` and `uq_open_shift_terminal ON (terminal_id) WHERE status = 'OPEN'`
- **`bill_counters`**: `branch_id (FK)`, `year integer`, `last_seq integer`, `UNIQUE(branch_id, year)`
- **`bills`**: `id (PK)`, `branch_id (FK)`, `cashier_id (FK)`, `bill_number (UNIQUE)`, `status ('OPEN'|'PAID'|'VOIDED')`, `subtotal`, `tax_amount`, `discount`, `total`, `payment_mode`, `customer_id (FK)`, `shift_session_id (FK)`, `client_ref (UNIQUE)`, `paid_at`, `voided_at`, `void_reason`, `created_at`
- **`bill_items`**: `id (PK)`, `bill_id (FK cascade)`, `product_id (FK)`, `quantity`, `unit_price`, `tax_rate`, `tax_amount`, `line_total`

### 5.4 Daily Counter Sheets & Day Closing
- **`daily_counter_sheets`**: `id (PK)`, `branch_id (FK)`, `sheet_date date`, `status ('DRAFT'|'POSTED')`, `total_revenue`, `created_by_id`, `posted_by_id`, `posted_at`, `UNIQUE(branch_id, sheet_date)`
- **`daily_counter_sheet_lines`**: `id (PK)`, `sheet_id (FK cascade)`, `product_id (FK)`, `opening_bottles`, `inward_bottles`, `closing_bottles`, `sold_bottles`, `selling_rate`, `line_revenue`, `adjustment_approved_by_id`, `UNIQUE(sheet_id, product_id)`
- **`daily_closings`**: `id (PK)`, `branch_id (FK)`, `closed_by_id (FK)`, `closing_date`, `opening_cash`, `cash_sales`, `card_sales`, `upi_sales`, `credit_sales`, `gross_sales`, `total_tax`, `cash_withdrawals`, `expected_cash_in_drawer`, `actual_cash_counted`, `cash_discrepancy`, `is_balanced`, `total_bills_count`, `paid_bills_count`, `voided_bills_count`, `notes`, `status`

### 5.5 Supplier Invoices & Attachments
- **`supplier_invoices`**: `id (PK)`, `branch_id (FK)`, `created_by_id (FK)`, `reviewed_by_id (FK)`, `approved_by_id (FK)`, `rejected_by_id (FK)`, `supplier_name`, `invoice_number`, `invoice_date`, `total_amount`, `status ('DRAFT'|'REVIEWED'|'APPROVED'|'REJECTED')`, `source ('MANUAL'|'CSV'|'EXCEL'|'PDF'|'IMAGE')`, `original_filename`, `notes`, `rejection_reason`, `extraction_warnings (jsonb)`, `extraction_meta (jsonb)`, `created_at`, `reviewed_at`, `approved_at`, `rejected_at`
  - Partial unique index: `uq_supplier_invoice_live_number ON (branch_id, supplier_name, invoice_number) WHERE status <> 'REJECTED'`
- **`supplier_invoice_items`**: `id (PK)`, `invoice_id (FK cascade)`, `product_id (FK nullable)`, `line_number`, `raw_description`, `barcode`, `quantity`, `cost_price`, `mrp`, `tax_rate`, `line_cost_total`, `extracted_amount`, `match_status`, `match_method`, `match_confidence`, `flags (jsonb)`
- **`invoice_attachments`**: `id (PK)`, `invoice_id (FK cascade)`, `filename`, `mime_type`, `size_bytes`, `sha256`, `data (bytea)`, `created_at`

### 5.6 Customer Khata, Supplier Schemes, Tables/KOT & Compliance
- **`customers`**: `id (PK)`, `branch_id (FK)`, `name`, `phone`, `credit_allowed`, `credit_limit`, `current_credit`, `is_active`, `UNIQUE(branch_id, phone)`
- **`credit_transactions`**: `id (PK)`, `customer_id (FK)`, `type ('PURCHASE'|'REPAYMENT'|'ADJUSTMENT')`, `amount`, `balance_after`, `bill_id (FK)`, `payment_mode`, `recorded_by_id (FK)`, `client_ref (UNIQUE)`, `notes`, `recorded_at`
- **`schemes`**: `id (PK)`, `branch_id (FK)`, `supplier_name`, `scheme_name`, `target_type ('QTY'|'VALUE')`, `target_value`, `current_value`, `reward_description`, `start_date`, `end_date`, `alert_threshold_pct`, `status`
- **`scheme_purchases`**: `id (PK)`, `scheme_id (FK)`, `reference_id`, `qty`, `value`, `recorded_at`, `notes`
- **`scheme_slabs`**: `id (PK)`, `scheme_id (FK cascade)`, `min_cases`, `free_bottles`, `discount_per_case`, `UNIQUE(scheme_id, min_cases)`
- **`tables`** & **`table_sessions`** & **`kot_orders`** & **`kot_items`**: Full floor/bar table occupancy and kitchen/bar order lifecycle.
- **`excise_quotas`** & **`breakage_logs`**: Category quota tracking and breakage loss records.

### 5.7 Double-Entry Accounting
- **`account_ledgers`**: `id (PK)`, `branch_id (FK)`, `code`, `name`, `group ('ASSET'|'LIABILITY'|'EQUITY'|'INCOME'|'EXPENSE')`, `is_system`, `opening_balance numeric(14,2)`, `UNIQUE(branch_id, code)`
- **`journal_vouchers`**: `id (PK)`, `branch_id (FK)`, `voucher_number (UNIQUE)`, `voucher_date date`, `voucher_type ('SALES'|'PURCHASE'|'PAYMENT'|'RECEIPT'|'JOURNAL'|'CONTRA')`, `narration`, `source_type`, `source_id`, `created_by_id (FK)`, `UNIQUE(source_type, source_id)`
- **`journal_lines`**: `id (PK)`, `voucher_id (FK cascade)`, `ledger_id (FK)`, `debit numeric(14,2)`, `credit numeric(14,2)`
- **`expenses`**: `id (PK)`, `branch_id (FK)`, `category`, `amount`, `payment_mode`, `expense_date`, `notes`, `recorded_by_id (FK)`

---

## 6. Core Domain Engines & Business Algorithms

### 6.1 POS Billing & Post-Discount GST Engine (`src/modules/billing/billing.engine.ts`)
1. Duplicate product lines in the request are merged (`mergeBillItems`).
2. Each line's gross total is computed as $\text{gross}_i = \text{MRP}_i \times \text{qty}_i$, and $\text{subtotal} = \sum \text{gross}_i$.
3. Discount is validated ($0 \le \text{discount} \le \text{subtotal}$) and allocated proportionally across lines:
   $$\text{disc}_i = \text{round\_half\_up}\left(\text{discount} \times \frac{\text{gross}_i}{\text{subtotal}}, 2\right)$$
   Any 1-paise rounding residual is applied to the line with the largest gross value so $\sum \text{disc}_i = \text{discount}$ holds exactly.
4. For each line with $\text{net}_i = \text{gross}_i - \text{disc}_i$:
   $$\text{taxable}_i = \text{round\_half\_up}\left(\frac{\text{net}_i}{1 + \text{taxRate}_i / 100}, 2\right), \quad \text{tax}_i = \text{net}_i - \text{taxable}_i$$
5. Bill numbers are generated atomically per branch and business year via `bill_counters` (`<BRANCH_CODE>-<YYYY>-<6-digit sequence>`, e.g., `MAIN-01-2026-000001`).

### 6.2 Cashier Shifts & Daily Counter Sheets (`src/modules/shifts/shift.engine.ts`, `src/modules/counters/counter.engine.ts`)
- **Cashier Shift:**
  - Enforces at most one `OPEN` shift per cashier and per terminal (backed by partial unique indexes).
  - Bills created by a cashier with an open shift automatically link `shift_session_id` (acquired under `FOR SHARE` lock so closing a shift never misses an in-flight bill).
  - At shift close, physical denomination counts (`₹2000`, `₹500`, `₹200`, `₹100`, `₹50`, `₹20`, `₹10`, plus `coins`) are summed and compared to $\text{Expected Cash} = \text{Opening Float} + \text{Cash Sales}$:
    $$\text{Discrepancy} = \text{Counted Cash} - \text{Expected Cash}$$
- **Daily Counter Sheet:**
  - Models traditional Indian liquor counter sheets where physical bottle counts determine sales:
    $$\text{Sold} = \text{Opening} + \text{Inward} - \text{Closing}$$
  - Opening bottles default to the previous posted sheet's closing bottles (plus any approved purchases in between if days were skipped), or current live stock for the first sheet.
  - If $\text{Closing} > \text{Opening} + \text{Inward}$ (a surplus), posting is blocked unless a manager explicitly sets `approveAdjustment = true`.
  - Posting a counter sheet atomically reconciles `stock.quantity` to `closing_bottles` and writes `COUNTER_SHEET` audit entries.

### 6.3 Supplier Invoice Extraction, Matching & Workflow Engine (`src/modules/invoices/**`)
All document extraction runs **100% locally with zero external API keys or per-page cost**:

1. **Content Sniffing (`extraction/detect-type.ts`):**
   - Inspects magic bytes (`%PDF-`, PNG `\x89PNG`, JPEG `\xFF\xD8\xFF`, OOXML ZIP containing `xl/workbook.xml`, UTF-8 CSV/TSV text) and rejects unsupported or binary files (`415 Unsupported Media Type`) and images exceeding 40 megapixels (decompression-bomb guard).
2. **Tabular & Text Extraction (`extraction/tabular.ts`, `pdf-text.ts`, `ocr.ts`, `table.engine.ts`, `text-lines.engine.ts`):**
   - **CSV / TSV:** Auto-detects delimiter (`,`, `\t`, `;`, `|`) via `papaparse`.
   - **XLSX:** Reads cell values, formula cached results, rich text, and dates via `exceljs`.
   - **PDF:** Extracts positioned text items (`x, y, width, fontSize`) via `pdfjs-dist` and reconstructs lines/columns; pages with `< 20` characters of text are treated as scanned pages, rendered at `2×` scale via `@napi-rs/canvas`, and passed to OCR.
   - **OCR (`tesseract.js`):** Runs a serialized (`concurrency = 1`), timeout-guarded (`30s`) worker using the local `4.0.0` English model (`tessedit_pageseg_mode = 6`, preserved inter-word spaces), upscaling images narrower than `2000px` by `2×`.
3. **Catalog Matching (`match.engine.ts`):**
   - Priority 1: Exact barcode match (`confidence = 1.000`, `MATCHED`).
   - Priority 2: Exact SKU match (`confidence = 1.000`, `MATCHED`).
   - Priority 3: Weighted token Dice similarity (`brand` tokens weighted `2×`, generic liquor words weighted `0.5×`, OCR character swap normalization `0→o`, `1→l`, `5→s`, `8→b`, 1-edit tolerance on 5+ char words) combined with volume comparison (`750ml`, `1L`, `75cl`):
     - $\text{confidence} \ge 0.85$ (and $\ge 0.05$ ahead of runner-up) $\rightarrow$ `MATCHED`
     - $0.60 \le \text{confidence} < 0.85$ (or ambiguous runner-up) $\rightarrow$ `SUGGESTED` (requires human confirmation before approval)
     - $< 0.60 \rightarrow$ `UNMATCHED`
4. **Case-to-Bottle Conversion & Validation (`draft.engine.ts`, `validate.engine.ts`):**
   - Converts `cases` to bottles using the matched product's `packQuantity` (`CASES_CONVERTED`), automatically dividing per-case rates into per-bottle cost when `cases × rate ≈ extractedAmount`.
   - Computes line flags (`AMOUNT_MISMATCH`, `MRP_CHANGED`, `COST_ABOVE_MRP`, `LOW_CONFIDENCE`, `UNREADABLE_NUMBER`, `VOLUME_DIFFERS`, `CASES_NO_PACK_SIZE`, `INCOMPLETE`, `UNMATCHED`, `NEEDS_CONFIRMATION`) and invoice warnings (`TOTAL_MISMATCH`, `INVOICE_NUMBER_MISSING`, `SUPPLIER_MISSING`, `INVOICE_DATE_IN_FUTURE`, `DUPLICATE_FILE`, `HEADER_FROM_OCR`, `OCR_USED`).
5. **Approval Effects (`invoice-workflow.service.ts` + `inventory.service.ts`):**
   - Conditional status transition (`DRAFT | REVIEWED → APPROVED`) prevents double-approval under concurrency.
   - Atomically increments `stock`, writes `PURCHASE` rows to `stock_audit`, updates `products.cost_price` and `products.mrp` (with `price_audit` on MRP change), credits any matching `ACTIVE` supplier schemes (`schemes` + `scheme_purchases`), and emits `supplierInvoice.approved` to post the purchase journal voucher.

### 6.4 Inventory, Reorder Indent & Excise Compliance (`src/modules/stock/indent.engine.ts`, `src/modules/compliance/**`)
- **Reorder Indent Formula:**
  - Given 30-day paid sales (`totalSoldInPeriod`), `leadTimeDays = 5`, `bufferDays = 3`:
    $$\text{Velocity/day} = \frac{\text{Total Sold}}{\text{Period Days}}, \quad \text{Target Stock} = \lceil \text{Velocity/day} \times (\text{Lead Time} + \text{Buffer}) \rceil$$
    $$\text{Suggested Reorder} = \max(0, \text{Target Stock} - \text{Current Stock})$$
    (rounded up to full cases when `casePackSize` is configured).
- **Excise Quota Lifting (`lifting.engine.ts`):**
  - Aggregates approved purchase quantities in cases ($\text{bottles} / \text{packQuantity}$) per category within each quota's `[periodStart, periodEnd]` window and flags `EXCEEDED` ($\ge 100\%$), `EXPIRING` ($\le 7$ days left and $< 100\%$), or `EXPIRED_UNMET`.
- **Breakage (`compliance.service.ts`):**
  - Deducts broken bottles using guarded atomic SQL (`quantity >= n`), logs `breakage_logs` with `costValue = qty × costPrice`, writes a `BREAKAGE` row to `stock_audit`, and posts a `BREAKAGE_LOSS / PURCHASES` journal voucher.

### 6.5 Customer Khata (Credit) & Supplier Schemes (`src/modules/customers/credit.engine.ts`, `src/modules/schemes/**`)
- **Customer Khata:**
  - Normalizes 10-digit Indian mobile numbers (`[6-9]\d{9}`, stripping `+91` / `0` prefixes).
  - Enforces `currentCredit + billTotal <= creditLimit` under a `FOR UPDATE` row lock on `customers`.
  - Records `PURCHASE`, `REPAYMENT` (with `clientRef` idempotency), and `ADJUSTMENT` (on bill void) with running balance verification.
- **Supplier Schemes & Slabs (`slab.engine.ts`):**
  - Evaluates total cases lifted against non-cumulative case slabs ("best slab reached" rule: highest `minCases <= totalCases`), computing `freeBottles`, `discountTotal = totalCases × discountPerCase`, and `casesToNextSlab`.

### 6.6 Bar Table Sessions & KOT State Machine (`src/modules/tables/table.engine.ts`, `src/modules/kot/kot.engine.ts`)
- **Table Lifecycle:** `FREE → OCCUPIED` (creates `table_sessions` row) `→ FREE` (sets `closed_at` and optional `bill_id`).
- **KOT Item State Machine:**
  - Allowed one-way transitions:
    - `PENDING → PREPARING | CANCELLED`
    - `PREPARING → SERVED | CANCELLED`
    - `SERVED` and `CANCELLED` are terminal states.
  - Parent `kot_orders.status` is automatically derived from its items (`ALL CANCELLED → CANCELLED`, `ALL SERVED/CANCELLED → SERVED`, `ANY PREPARING/SERVED → PREPARING`, else `PENDING`).
  - `GET /api/v1/kot/session/:sessionId/bill` aggregates all non-cancelled KOT items across orders for the table session and computes the itemized GST bill preview for one-click POS checkout.

### 6.7 Double-Entry Accounting & Tally XML Exporter (`src/modules/accounting/**`)

#### System Chart of Accounts (`chart.ts`)
| Code | Ledger Name | Group | Tally Parent Group |
|---|---|---|---|
| `CASH` | Cash in Hand | `ASSET` | `Cash-in-Hand` |
| `BANK` | Bank Account | `ASSET` | `Bank Accounts` |
| `SUNDRY_DEBTORS` | Sundry Debtors (Khata) | `ASSET` | `Sundry Debtors` |
| `INPUT_GST` | Input GST | `ASSET` | `Duties & Taxes` |
| `SUNDRY_CREDITORS` | Sundry Creditors (Suppliers) | `LIABILITY` | `Sundry Creditors` |
| `OUTPUT_GST` | Output GST | `LIABILITY` | `Duties & Taxes` |
| `OWNER_EQUITY` | Owner's Equity | `EQUITY` | `Capital Account` |
| `SALES` | Sales Account | `INCOME` | `Sales Accounts` |
| `PURCHASES` | Purchases Account | `EXPENSE` | `Purchase Accounts` |
| `DISCOUNT_ALLOWED` | Discount Allowed | `EXPENSE` | `Indirect Expenses` |
| `BREAKAGE_LOSS` | Breakage & Damage Loss | `EXPENSE` | `Indirect Expenses` |
| `EXPENSE_<CAT>` | `<Category> Expense` (auto-created) | `EXPENSE` | `Indirect Expenses` |

#### Automatic Event-Driven Voucher Postings (`ledger.engine.ts`)
1. **Sale (`bill.paid`, `SALES` voucher):**
   - `Dr` `CASH` / `BANK` (Card/UPI) / `SUNDRY_DEBTORS` (Credit) = `bill.total`
   - `Dr` `DISCOUNT_ALLOWED` = `bill.discount` (if $> 0$)
   - `Cr` `SALES` = `bill.subtotal − bill.taxAmount` (gross taxable plus discount)
   - `Cr` `OUTPUT_GST` = `bill.taxAmount`
2. **Bill Void (`bill.voided`, `JOURNAL` voucher):**
   - Exact debit/credit mirror of the original `BILL` voucher (`source_type = 'BILL_VOID'`, `created_by_id = voidedById`).
3. **Supplier Invoice Approved (`supplierInvoice.approved`, `PURCHASE` voucher):**
   - `Dr` `PURCHASES` = $\sum \text{lineCostTotal}$
   - `Cr` `SUNDRY_CREDITORS` = $\sum \text{lineCostTotal}$
4. **Khata Repayment (`credit.repayment`, `RECEIPT` voucher):**
   - `Dr` `CASH` (or `BANK` for Card/UPI) = `txn.amount`
   - `Cr` `SUNDRY_DEBTORS` = `txn.amount`
5. **Expense Recorded (`expense.recorded`, `PAYMENT` voucher):**
   - `Dr` `EXPENSE_<CATEGORY>` = `expense.amount`
   - `Cr` `CASH` (or `BANK`) = `expense.amount`

#### Tally Prime / ERP 9 XML Export (`tally.exporter.ts`)
- Generates an XML 1.0 compliant `<ENVELOPE>` (`<TALLYREQUEST>Import Data</TALLYREQUEST>`).
- Strips illegal XML 1.0 control characters and lone surrogates (`XML_ILLEGAL`).
- Emits `<LEDGER NAME="..." ACTION="Create">` master blocks with `<PARENT>` group mappings ahead of `<VOUCHER>` blocks so imports succeed in blank Tally companies.
- Uses Tally's sign convention (`ISDEEMEDPOSITIVE="Yes"` with negative amount for Debits; `ISDEEMEDPOSITIVE="No"` with positive amount for Credits).

---

## 7. Complete REST API Specification (`/api/v1`)

All protected routes require `Authorization: Bearer <jwt>`.

### 7.1 Authentication, Users, Branches & Syndicates
| Method & Path | Min Role | Description |
|---|---|---|
| `POST /api/v1/auth/login` | Public | Authenticate `{ email, password }` → `{ token }` |
| `GET /api/v1/me` | `steward` | Current user profile, assigned branch & page permissions |
| `GET /api/v1/users?branchId=` | `manager` | List users in accessible scope |
| `POST /api/v1/users` | `manager` | Create user (managers can only create `cashier`/`steward` in own branch) |
| `PATCH /api/v1/users/:id` | `manager` | Update `name`, `role`, or `isActive` |
| `GET /api/v1/users/:id/pages` | `manager` | Read user's page-permission matrix |
| `PUT /api/v1/users/:id/pages` | `manager` | Replace user's page-permission matrix |
| `GET /api/v1/branches` | `steward` | List branches accessible to the caller |
| `POST /api/v1/branches` | `owner` | Create a new branch (`code` 2–10 alphanumeric chars) |
| `PATCH /api/v1/branches/:id` | `owner` | Update branch details or parent branch (cycle-checked) |
| `GET /api/v1/syndicates` | `owner` | List syndicates in scope |
| `POST /api/v1/syndicates` | `owner` (platform) | Create a syndicate |
| `PATCH /api/v1/syndicates/:id` | `owner` | Update syndicate metadata |
| `GET /api/v1/syndicates/:id/branches` | `owner` | List branches belonging to a syndicate |
| `POST /api/v1/syndicates/:id/branches/:branchId` | `owner` | Attach branch to syndicate |
| `GET /api/v1/syndicates/:id/consolidated-invoices` | `owner` | List consolidated syndicate invoices |
| `POST /api/v1/syndicates/:id/consolidated-invoices` | `owner` | Generate consolidated invoice for `[periodStart, periodEnd]` |

### 7.2 Catalog, Billing, Registers, Shifts & Counter Sheets
| Method & Path | Min Role | Description |
|---|---|---|
| `GET /api/v1/products` | `steward` | List active catalog with `categoryName` & `taxRate` (`costPrice` omitted for stewards) |
| `GET /api/v1/products/barcode/:barcode` | `cashier` | Fast barcode lookup for scanner POS |
| `POST /api/v1/products` | `manager` | Create catalog product |
| `PATCH /api/v1/products/:id/mrp` | `manager` | Update product MRP and write `price_audit` |
| `POST /api/v1/bills` | `cashier` | Create `PAID` bill (`201`, or `200` on `clientRef` idempotent replay) |
| `GET /api/v1/bills` | `cashier` | Paginated bill history (`?branchId=&date=&status=&limit=&offset=`) |
| `GET /api/v1/bills/:id` | `cashier` | Full bill detail with line items |
| `POST /api/v1/bills/:id/void` | `manager` | Void bill (`{ voidReason }`), reverse stock, credit & accounting |
| `GET /api/v1/terminals/:branchId` | `cashier` | List branch terminals (`deviceKey` visible to `manager+` only) |
| `POST /api/v1/terminals/:branchId` | `manager` | Register a POS terminal |
| `PATCH /api/v1/terminals/:id` | `manager` | Rename or activate/deactivate terminal (blocked if shift is `OPEN`) |
| `POST /api/v1/shifts/open` | `cashier` | Open shift on a terminal (`{ terminalId, openingFloat }`) |
| `GET /api/v1/shifts/current` | `cashier` | Active shift for caller with live collection summary |
| `POST /api/v1/shifts/:id/close` | `cashier` | Close shift with denomination counts & compute discrepancy |
| `GET /api/v1/shifts?branchId=&date=` | `manager` | List branch shifts |
| `POST /api/v1/counter-sheets/:branchId` | `cashier` | Create or return `DRAFT` counter sheet for `{ sheetDate }` |
| `GET /api/v1/counter-sheets/:branchId?date=` | `cashier` | List counter sheets for branch |
| `GET /api/v1/counter-sheets/sheet/:id` | `cashier` | Full counter sheet with lines and case/loose split |
| `PUT /api/v1/counter-sheets/sheet/:id/lines` | `cashier` | Update closing/inward bottle counts on a `DRAFT` sheet |
| `POST /api/v1/counter-sheets/sheet/:id/post` | `manager` | Post counter sheet and reconcile branch stock |
| `POST /api/v1/closing` | `manager` | Submit end-of-day cash reconciliation report |
| `GET /api/v1/closing?branchId=` | `manager` | List daily closing reports |

### 7.3 Inventory, Supplier Invoices, Khata, Schemes, Tables/KOT, Compliance & Accounting
| Method & Path | Min Role | Description |
|---|---|---|
| `GET /api/v1/inventory/stock/:branchId` | `cashier` | Live stock quantities and reorder levels |
| `GET /api/v1/inventory/indent/:branchId` | `manager` | 30-day velocity reorder indent estimations |
| `POST /api/v1/inventory/invoices/parse` | `manager` | Validate raw JSON invoice totals & catalog matches |
| `POST /api/v1/inventory/invoices/approve` | `manager` | Direct one-step invoice approval |
| `POST /api/v1/invoices/:branchId/upload` | `cashier` | Multipart upload (CSV/XLSX/PDF/PNG/JPG ≤ 10 MB) → `DRAFT` invoice |
| `POST /api/v1/invoices/:branchId` | `cashier` | Create manual `DRAFT` supplier invoice |
| `GET /api/v1/invoices/:branchId` | `cashier` | List supplier invoices (`?status=&from=&to=&q=&limit=&offset=`) |
| `GET /api/v1/invoices/detail/:id` | `cashier` | Full invoice detail, lines, flags & attachment metadata |
| `GET /api/v1/invoices/detail/:id/file` | `cashier` | Download original uploaded file (`nosniff` + sandbox CSP) |
| `PUT /api/v1/invoices/detail/:id` | `cashier` | Edit `DRAFT` / `REVIEWED` invoice header, lines & product matches |
| `POST /api/v1/invoices/detail/:id/review` | `manager` | Transition `DRAFT → REVIEWED` |
| `POST /api/v1/invoices/detail/:id/approve` | `manager` | Transition `DRAFT|REVIEWED → APPROVED` (stock, audit, schemes, voucher) |
| `POST /api/v1/invoices/detail/:id/reject` | `manager` | Transition `DRAFT|REVIEWED → REJECTED` (`{ reason }`) |
| `GET /api/v1/customers/:branchId?search=` | `cashier` | List/search khata customers |
| `POST /api/v1/customers/:branchId` | `cashier` | Create customer (credit limit/allowance fields require `manager+`) |
| `PATCH /api/v1/customers/:id` | `cashier` | Update customer details (credit settings require `manager+`) |
| `GET /api/v1/customers/:id/statement` | `cashier` | Customer khata ledger statement with running balance |
| `POST /api/v1/customers/:id/repayments` | `cashier` | Record khata repayment (idempotent on `clientRef`) |
| `GET /api/v1/customers/:branchId/outstanding` | `manager` | Customers with positive credit balance + total outstanding |
| `GET /api/v1/schemes/:branchId` | `manager` | List supplier schemes with progress % |
| `GET /api/v1/schemes/:branchId/alerts` | `manager` | Active schemes at or above alert threshold % |
| `POST /api/v1/schemes/:branchId` | `manager` | Create supplier scheme |
| `POST /api/v1/schemes/:schemeId/purchase` | `manager` | Record purchase progress against scheme |
| `GET /api/v1/schemes/:schemeId/slabs` | `manager` | List case slabs for scheme |
| `POST /api/v1/schemes/:schemeId/slabs` | `manager` | Replace case slabs for scheme |
| `GET /api/v1/schemes/:schemeId/payout` | `manager` | Compute slab payout (free bottles, discount earned, next slab) |
| `GET /api/v1/tables/:branchId` | `steward` | List tables with live `currentSessionId` and `sessionOpenedAt` |
| `POST /api/v1/tables/:branchId` | `manager` | Create floor/bar table |
| `POST /api/v1/tables/:tableId/open` | `cashier` | Open table session (`FREE → OCCUPIED`) |
| `POST /api/v1/tables/:tableId/close` | `cashier` | Close table session (`OCCUPIED → FREE`) |
| `POST /api/v1/kot` | `steward` | Create Kitchen/Bar Order Ticket (`KOT`) for an open table session |
| `PATCH /api/v1/kot/:kotOrderId/items/:itemId` | `steward` | Advance or cancel a KOT item (`PENDING → PREPARING → SERVED`) |
| `GET /api/v1/kot/session/:sessionId` | `steward` | List KOT orders & items for a table session |
| `GET /api/v1/kot/session/:sessionId/bill` | `cashier` | Compute aggregated GST bill preview for a table session |
| `GET /api/v1/compliance/quotas/:branchId` | `manager` | List excise quotas |
| `POST /api/v1/compliance/quotas/:branchId` | `manager` | Create excise quota |
| `GET /api/v1/compliance/lifting/:branchId` | `manager` | Quota vs actual case lifting report (`?from=&to=`) |
| `POST /api/v1/compliance/breakage/:branchId` | `cashier` | Record bottle breakage (deducts stock, audits, posts loss voucher) |
| `GET /api/v1/compliance/breakage/:branchId` | `manager` | Breakage log and cost summary (`?from=&to=`) |
| `GET /api/v1/compliance/stock-audit/:branchId` | `manager` | Stock movement audit trail and per-product summary |
| `GET /api/v1/accounting/ledgers/:branchId` | `manager` | Chart of accounts with live balances |
| `POST /api/v1/accounting/ledgers/:branchId` | `manager` | Create custom ledger |
| `GET /api/v1/accounting/ledgers/:branchId/:ledgerId/entries` | `manager` | Ledger statement with opening/running/closing balance |
| `GET /api/v1/accounting/vouchers/:branchId` | `manager` | Day book vouchers (`?from=&to=&type=&limit=`) |
| `POST /api/v1/accounting/journal/:branchId` | `manager` | Post balanced manual journal voucher |
| `GET /api/v1/accounting/trial-balance/:branchId` | `manager` | Trial Balance report (`?asOf=`) |
| `GET /api/v1/accounting/profit-loss/:branchId` | `manager` | Profit & Loss statement (`?from=&to=`) |
| `GET /api/v1/accounting/balance-sheet/:branchId` | `manager` | Balance Sheet report (`?asOf=`) |
| `GET /api/v1/accounting/tally-export/:branchId` | `manager` | Download Tally Prime / ERP 9 XML (`?from=&to=&company=`) |
| `GET /api/v1/expenses/:branchId` | `manager` | List branch expenses & category totals (`?from=&to=`) |
| `POST /api/v1/expenses/:branchId` | `manager` | Record expense and auto-post payment voucher |

---

## 8. Frontend Architecture (`preview.html`)

The web UI is a zero-build, single-file application (`preview.html`) served at `GET /` and `GET /preview`:

- **Role-Aware Navigation & Branch Context:**
  - Dynamically renders the 14 navigation sections based on the signed-in user's role rank (`steward`, `cashier`, `manager`, `owner`).
  - Syndicate and platform owners get a live branch selector in the top bar (persisted per user in `localStorage`); switching branches clears branch-scoped caches (`cart`, `tables`, `ledgers`, `selectedCustomerId`, `activeInvoice`) and reloads the catalog.
- **Per-User Offline Billing Queue:**
  - When `navigator.onLine === false` or a network error occurs during POS checkout, bills are queued in `localStorage` under `lc_offline_bills:<userSub>` with a UUIDv4 `clientRef` and `ownerSub`.
  - A background timer (every 10s) and `window.ononline` listener sync queued bills ONLY when the same user is signed in, preventing cross-user attribution on shared POS terminals.
  - Late-synced bills that cross a business-day boundary raise a prominent toast and status notice.
- **Accessibility (WCAG 2.2 AA) & Responsive Layout:**
  - Full dark and light theme variables (`data-theme="dark"` / `"light"`).
  - Modal focus trap (`Tab` / `Shift+Tab` wrapping), `inert` + `aria-hidden` background isolation when modals or the mobile navigation drawer are open, ARIA tablist keyboard navigation (`ArrowLeft`, `ArrowRight`, `Home`, `End`) on Accounting tabs, and inline `role="alert"` field validation errors.

---

## 9. Concurrency, Security & Data Integrity Controls

1. **Guarded Atomic Stock Updates:**
   - Sales and breakage never use read-modify-write in JS; they execute `UPDATE stock SET quantity = quantity - $n WHERE branch_id = $b AND product_id = $p AND quantity >= $n RETURNING id` (sorted by `productId` to prevent deadlocks).
2. **Race-Free State Transitions:**
   - Bill voiding (`WHERE id = $id AND status <> 'VOIDED'`), invoice review (`WHERE id = $id AND status = 'DRAFT'`), and invoice approval (`WHERE id = $id AND status IN ('DRAFT', 'REVIEWED')`) use conditional `UPDATE ... RETURNING` so concurrent requests cannot double-void or double-approve.
3. **Upload & Download Hardening:**
   - Multipart uploads are capped at 1 file ≤ 10 MB, 10 fields ≤ 8 KB.
   - File types are verified by magic bytes, not client MIME headers or extensions.
   - Attachment downloads serve `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`, and RFC 6266 sanitized `Content-Disposition`.
4. **Input & Output XSS Defense:**
   - Backend Zod schemas reject HTML angle brackets (`<` and `>`) on entity names/identifiers (`400 Bad Request`).
   - All dynamic strings interpolated into HTML in `preview.html` pass through `esc()`.

---

## 10. Testing & Verification Architecture

| Suite | Command | Scope & Runner |
|---|---|---|
| **Typecheck** | `npx tsc --noEmit` | Full strict TypeScript verification across `src/` |
| **Unit Tests** | `npm run test:unit` | 25 test files testing pure engines (`billing`, `stock`, `indent`, `shift`, `counter`, `credit`, `scheme`, `slab`, `lifting`, `kot`, `table`, `ledger`, `reports`, `tally.exporter`, `invoices.engines`, `consolidation`, `user`, `page-guard`, `domain-events`) |
| **Integration Tests** | `npm run test:integration` | 12 test files booting the real Fastify app + SQL migrations on isolated in-memory PGlite instances (`setupIntegration()`) |
| **End-to-End Tests** | `npm run test:e2e` | 12 Playwright spec files (21 browser journeys) against a fresh PGlite instance (`.pglite-e2e`) covering login, POS checkout, shifts, counter sheets, khata credit & repayment, bill voiding, steward KOTs, offline billing & cross-user isolation, accounting & Tally download, owner branch closing, and supplier invoice CSV upload → review → approval |

---

## 11. Deployment, Configuration & Operations

### Environment Variables

| Variable | Default (Dev) | Description |
|---|---|---|
| `DATABASE_URL` | `pglite://./.pglite` (in `dev:local`) | `postgresql://user:pass@host:5432/db` for PostgreSQL, or `pglite://<path>` / `pglite://memory` |
| `JWT_SECRET` | — | **Required in production (`NODE_ENV=production`)**, minimum 32 characters |
| `JWT_EXPIRES_IN` | `8h` | JWT token lifetime |
| `PORT` | `3001` | HTTP listen port |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |
| `BUSINESS_UTC_OFFSET_MINUTES` | `330` | Store timezone offset from UTC in minutes (`330` = IST) |
| `OCR_PAGE_TIMEOUT_MS` | `30000` | Per-page timeout for local Tesseract OCR |

### Schema Migration Workflow

```bash
# 1. Edit src/db/schema.ts
# 2. Generate SQL migration in ./drizzle:
DATABASE_URL="postgresql://x:x@localhost:5432/x" npm run db:generate
# 3. Apply migrations:
npm run db:migrate
```
