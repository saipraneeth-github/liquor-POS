# Accounting and dashboard expense review — 27 November 2026

## Design plan and result

The previous accounting page offered nine competing buttons, opened on Trial Balance, used dense tables on phones and squeezed expense entry into one row. Report failures could leave an empty area. Daily staff needed a clear entry point and a way to record spending without leaving the dashboard.

- P1, safe: shared expense popup from Accounting and Dashboard, with shop, amount, category, payment mode, date and note. Implemented for managers with posting permission, business owners, office admins and cashiers.
- P1, safe: Accounting header with Record expense as its main action; grouped Daily accounts and Reports navigation; compact selector on phones. Implemented.
- P2, safe: Cash Book as the landing view; readable balance figures; stacked cash-book, expense and trial-balance rows on phones. Implemented.
- P2, safe: visible loading, empty, retry and success states, with new English/Hindi/Telugu copy. Implemented.
- Product decision, deferred: expense approval workflow, cashier spending caps and dedicated per-user expense permissions. These were not introduced. Existing accounting.post restrictions remain for management; cashiers now have a role-based exception solely for expense creation, as requested.

## Changed files in this follow-up

- `frontend/src/accounting/AccountingNavigation.tsx`, `Ledger.tsx`, `accounting.css`: navigation, header, responsive report presentation and retry handling. Late report responses are ignored after the selected report or shop changes.
- `frontend/src/accounting/CashBook.tsx`, `Expenses.tsx`: readable cash figures, phone rows, loading/error states; expense entry is moved to the shared popup.
- `frontend/src/accounting/ExpenseModal.tsx`: shared form, inline validation and server errors, duplicate-click guard, focus on amount, shop selection for owners, preserved form values on failed save.
- `frontend/src/dashboard/Dashboard.tsx`: expense action for the requested roles, popup and success state; F2 cannot navigate away while the popup is open.
- `src/modules/expenses/expense.routes.ts`: cashier creation access only. Branch checks, service validation, closed-day rules, voucher calculation/posting and existing list/reversal guards remain in effect.
- `frontend/src/i18n/messages.ts`: new Hindi/Telugu labels; English uses source text.
- `tests/integration/accounting.int.test.ts`, `tests/e2e/dashboard-expenses.spec.ts`, `tests/e2e/accounting-and-roles.spec.ts`, `tests/unit/staff-ux.test.ts`: cashier access, posting and denial cases; popup flows and translation checks; updated accounting landing-page expectation.
- `AGENTS.md`, `PROGRESS.md`: handoff notes. Earlier uncommitted changes remain in the working tree.

## Verification

Passed: frontend `tsc -b`, backend `tsc --noEmit`, Vite build, 21 accounting integration tests, 20 focused unit tests, seven browser scenarios. After the final translation fix, the affected phone/language scenario passed again.

Browser checks used the isolated demo on port 3320: real expense saves for manager, owner, office admin and cashier; steward action hidden; zero-amount validation; failed save retains fields; focus and Escape; F2 protection; report retry; no horizontal page or popup overflow at 360px in English/Hindi/Telugu. Cash Book and expense history reflected a saved amount. Desktop and phone screenshots are under ignored `test-results/accounting-*.png` and `test-results/expense-*-360.png`. The local design evidence checker passed using a `.cjs` copy because the bundled CommonJS `.js` checker cannot run directly in this ESM repository.

Limits: this was targeted verification, not a full integration/e2e suite rerun. Existing wider-suite issues are recorded in PROGRESS.md. Supplier and margin tables retain their existing detailed behaviour; complex report tables may use their own horizontal scrolling. Expense category validation still requires an English letter or digit for a custom category; translated preset choices avoid that requirement for common expenses. No new dependencies or database migrations were introduced.

## Review locally

Open http://localhost:3320/accounting or http://localhost:3320/ for the dashboard. This fresh in-memory demo includes the new cashier backend permission. Port 3317 was kept running to preserve the uploaded bank statement; its running backend does not include the new cashier rule until restarted.

Use `manager@liquor.com`, `owner@liquor.com`, `officeadmin@liquor.com` or `cashier@liquor.com`, password `Password@123`.

PowerShell commands from the repository root (direct executables avoid the broken Volta npm launcher):

```powershell
git status --short
git diff
.\node_modules\.bin\vitest.cmd run tests/unit/staff-ux.test.ts tests/unit/navigation.test.ts
.\node_modules\.bin\vitest.cmd run tests/integration/accounting.int.test.ts --fileParallelism=false
.\node_modules\.bin\playwright.cmd test --config test-results/accounting-playwright.config.ts
```

The browser command targets the running disposable demo on 3320. Do not point it at a real database. The normal full e2e configuration still targets 3001 and was not run.

To start a fresh demo if 3320 is stopped:

```powershell
$env:DATABASE_URL='pglite://memory'
$env:PORT='3320'
$env:NODE_ENV='development'
$env:PAYMENT_PROVIDER='mock'
$env:SMTP_HOST=''
$env:JWT_SECRET='local_accounting_review_only_secret_32_chars'
node --import tsx src/dev-local.ts
```

Everything is local and uncommitted. No push, merge or deployment was performed.
