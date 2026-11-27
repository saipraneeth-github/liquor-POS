# PROGRESS.md — Liquor Counter POS

Updated 2026-11-27 (IST). See [AGENTS.md](AGENTS.md) for project rules and the [README](README.md) for setup.

## Current state

Workspace cleanup moved 46 generated browser snapshots and logs to the Windows Recycle Bin. The QC report and remaining screenshots were preserved. The report's linked `test-results/qa-audit/` folder was already absent.

The QC pass fixed sale-type price enforcement for billing and stock transfers, added translated accessible names to Day Closing payment fields, made manual supplier bills start unmatched, and reset bank filters when switching statements. The regression suite reflects the current workflows. See the [QC bug report](QC_BUG_REPORT_2026-11-27.txt) for reproductions, results and evidence.

The same working tree includes Cash Book as the Accounting landing tab, the shared dashboard expense form, role-aware navigation, and the bank statement review redesign. The bank defaults to one entry at a time. Advanced views and bulk controls are under **All entries & tools**. See the [accounting UX review](docs/accounting-ux-review.md).

## Latest verification

- Backend and frontend TypeScript checks and Vite production build passed.
- 772 unit, 581 integration and 82 Chromium E2E tests passed. The final browser run used a fresh in-memory PGlite database.
- The initial responsive audit covered 130 route, role and viewport combinations at 360×800, 768×1024 and 1440×900. Phone workflows were exercised in English, Hindi and Telugu.
- The temporary QA server was stopped. The local Volta npm wrapper failed, so verification used the repository executables directly. The Playwright `tsx` startup also failed on this workstation. Use the compiled `dist/dev-local.js` with an isolated DB if that recurs.

## Open items and known limits

- Real PostgreSQL row-lock and concurrency checks, physical devices, a full automated accessibility scan, and visual baseline comparison remain unverified. See the QA report for scope.
- The bank direct-input control referenced in the earlier UX review is still pending the two screenshots that identify it.
- Voids on already-closed days are outside the stored closing totals. Customer returns are outside draft counter sheets and require a physical closing count. Customer and supplier return reversal is unavailable.
- The excise stock register is a generic export. The Excise & Breakage page uses the signed-in user's branch.
- For PostgreSQL deployments, check pending migrations and use the [runbook](docs/RUNBOOK.md). The QC changes added no migrations or dependencies.

## Retired paths

- `preview.html` was retired when the React UI became the sole frontend.
- The one-step inventory invoice parse/approve endpoints were replaced by the supplier-invoice workflow. Free-goods entry still lacks an entry route.
- Keep the Zambient reverse-engineering material removed, per the user's request.
