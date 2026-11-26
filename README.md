# Liquor Counter POS

A point-of-sale (POS), inventory, compliance, and double-entry accounting platform for liquor retail stores, bars, and multi-store syndicates in India.

## Features

- **Counter POS & Offline Billing:** Barcode scanner and touch POS with tax-inclusive MRP, post-discount GST back-calculation, Cash / Card / UPI / Credit (Khata) checkout, and per-user offline bill queueing with idempotent sync (`clientRef`).
- **Cashier Shifts & Daily Counter Sheets:** Terminal management, cashier shift open/close with note/coin denomination counting and discrepancy tracking, and physical counter sheets (`Opening + Inward − Closing = Sold`).
- **Supplier Invoices (Upload, Extraction & Approval Workflow):** Local extraction from CSV, Excel (`.xlsx`), text/scanned PDF, and invoice photos (offline OCR via Tesseract), fuzzy catalog matching, case-to-bottle conversion, arithmetic/MRP validation flags, and `DRAFT → REVIEWED → APPROVED / REJECTED` workflow.
- **Inventory & Excise Compliance:** Live branch stock, 30-day velocity reorder indent estimation, breakage logging, stock-audit trail, and category excise quotas vs lifting reports.
- **Customer Khata & Supplier Schemes:** Customer credit limits, statements, repayments, and supplier target schemes with case-slab payout calculation.
- **Bar Tables & KOT:** Floor/bar table management (`FREE`, `OCCUPIED`, `RESERVED`), kitchen/bar order tickets (`PENDING → PREPARING → SERVED`), and one-click table billing at POS.
- **Double-Entry Accounting & Tally Export:** Automatic journal voucher posting via domain events (`bill.paid`, `bill.voided`, `supplierInvoice.approved`, `credit.repayment`, `expense.recorded`), manual journals, Trial Balance, Profit & Loss, Balance Sheet, and Tally Prime / ERP 9 XML export (with `<LEDGER>` masters and `<VOUCHER>` entries).
- **Multi-Tenancy & RBAC:** Platform owner, syndicate owner (consolidated invoices across branches), branch manager, cashier, and floor steward roles.

## Quick Start (Zero-Setup Local Mode)

Runs on an embedded PGlite database (`./.pglite`), automatically applies migrations, seeds demo data on first run, and serves both the API and web UI on `http://localhost:3001`:

```bash
npm install
npm run dev:local
```

Open **http://localhost:3001** in your browser.

## Repository Layout

| Path | What lives there |
|---|---|
| [src/](src/), [frontend/](frontend/), [print-agent/](print-agent/) | API, React app, and local printer companion |
| [drizzle/](drizzle/), [scripts/](scripts/), [.github/workflows/](.github/workflows/) | Database migrations, maintenance scripts, and CI |
| [tests/](tests/README.md) | Automated tests, QA utilities, and sample inputs. Real invoices and bank statements live in the Git-ignored `tests/fixtures/local/` folder. |
| [docs/](docs/), [docs/plans/](docs/plans/), [docs/qa/](docs/qa/), [docs/archive/](docs/archive/) | Project documentation, plans, QA guides, and historical work |
| [.agents/](.agents/) | Shared AI toolkit. Skills, agent definitions, rules, and workflows each have a folder here. |

Run the npm commands from the repository root. The root also holds npm, TypeScript, Drizzle, and test configuration. Local databases, builds, and browser output stay at their configured Git-ignored paths.

Start with [AGENTS.md](AGENTS.md) for project conventions, [PROGRESS.md](PROGRESS.md) for the handoff, or the [runbook](docs/RUNBOOK.md) for deployment. Optional services are covered in the [integrations guide](docs/INTEGRATIONS.md).

### Demo Accounts (Password: `Password@123`)

| Role | Email | Scope |
|---|---|---|
| Syndicate Owner | `owner@liquor.com` | All branches in syndicate (branch selector in header) |
| Branch Manager | `manager@liquor.com` | `MAIN-01 — Main Counter Branch` |
| Counter Cashier | `cashier@liquor.com` | `MAIN-01 — Main Counter Branch` |
| Floor Steward | `steward@liquor.com` | `MAIN-01 — Main Counter Branch` (Tables & KOT) |

## Running with PostgreSQL

```bash
cp .env.example .env
# Set DATABASE_URL=postgresql://... and JWT_SECRET (32+ chars) in .env
npm run db:migrate
npm run db:seed
npm run dev
```

## Testing

```bash
npm test                  # All Vitest unit & integration suites (in-memory PGlite)
npm run test:unit         # Pure domain engine unit tests
npm run test:integration  # Full Fastify + SQL integration tests
npm run test:e2e          # Playwright end-to-end browser journeys
```

For architecture details, data model, and API reference, see **[AGENTS.md](./AGENTS.md)** and **[PROGRESS.md](./PROGRESS.md)**.
