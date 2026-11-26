# Testing Liquor Counter

Run tests from the repository root.

- `npm run test:unit` runs the unit tests.
- `npm run test:integration` runs against an embedded in-memory database.
- `npm run build:frontend` and `npm run test:e2e` exercise the built React app. Free up port 3001 first so Playwright starts its own test server.

## Sample inputs

| Location | Contents |
|---|---|
| [fixtures/catalog/](fixtures/catalog/) | Versioned Telangana product catalog CSV |
| `fixtures/local/supplier-invoices/` | Private supplier PDFs for invoice extraction and import regression tests |
| `fixtures/local/bank-statements/` | Private bank statements for manual checks |

`tests/fixtures/local/` is Git-ignored. Tests that need optional supplier PDFs skip those cases if the files are absent. The bank tests generate their own inputs.

## QA tools

[tools/](tools/) holds the browser audits and invoice inspection scripts. To inspect a local supplier PDF, run `node --import tsx tests/tools/dump-pdf.mjs ICDC.pdf`. Use demo data for the browser audits. Manual walkthroughs and audit reports are under [docs/qa/](../docs/qa/).
