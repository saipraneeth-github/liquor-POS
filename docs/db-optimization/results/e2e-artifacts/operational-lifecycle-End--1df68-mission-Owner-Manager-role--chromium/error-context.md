# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: operational-lifecycle.spec.ts >> End-to-End Operational Lifecycle Tests >> Journey 6: Day Closing Reconciliation Submission (Owner/Manager role)
- Location: tests\e2e\operational-lifecycle.spec.ts:41:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#closingStatusMsg')
Expected substring: "Day Closed & Locked"
Received string:    "Failed: Closing figures differ from the system (cashSales: system 0.00 -> submitted 510.00; creditSales: system 0.00 -> submitted 160.00). Add a note (10+ characters) explaining why."
Timeout: 10000ms

Call log:
  - Expect "toContainText" locator('#closingStatusMsg') with timeout 10000ms
  - waiting for locator('#closingStatusMsg')
    5 × locator resolved to <div role="status" id="closingStatusMsg"></div>
      - unexpected value ""
    18 × locator resolved to <div role="status" id="closingStatusMsg">…</div>
       - unexpected value "Failed: Closing figures differ from the system (cashSales: system 0.00 -> submitted 510.00; creditSales: system 0.00 -> submitted 160.00). Add a note (10+ characters) explaining why."

```

```yaml
- status: "Failed: Closing figures differ from the system (cashSales: system 0.00 -> submitted 510.00; creditSales: system 0.00 -> submitted 160.00). Add a note (10+ characters) explaining why."
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('End-to-End Operational Lifecycle Tests', () => {
  4  |   test.beforeEach(async ({ page }) => {
  5  |     await page.goto('/');
  6  |   });
  7  | 
  8  |   test('Journey 5: Table Status Mutation (Open Table -> Occupied)', async ({ page }) => {
  9  |     // 1. Login as Cashier (Cashier has cashier role required for tables/open)
  10 |     await page.fill('#loginEmail', 'cashier@liquor.com');
  11 |     await page.fill('#loginPass', 'Password@123');
  12 |     await page.click('button:has-text("Sign In")');
  13 | 
  14 |     // 2. Navigate to Tables & KOT view
  15 |     await page.click('#nav-tables');
  16 |     await expect(page.locator('#page-tables')).toBeVisible();
  17 | 
  18 |     // 3. Locate a free table tile (by name, so its locator survives the re-render)
  19 |     await expect(page.locator('.table-tile').first()).toBeVisible({ timeout: 10000 });
  20 |     const freeTile = page.locator('.table-tile.table-FREE').first();
  21 |     const name = await freeTile.getAttribute('data-table');
  22 |     const tile = page.locator(`.table-tile[data-table="${name}"]`);
  23 | 
  24 |     // 4. Click tile to open it
  25 |     await tile.click();
  26 |     await expect(tile.locator('span').first()).toHaveText('OCCUPIED', { timeout: 5000 });
  27 | 
  28 |     // 5. Clicking an occupied tile never closes it: it opens the actions dialog instead
  29 |     await tile.click();
  30 |     await expect(page.locator('#modal')).toBeVisible();
  31 |     await expect(page.locator('#tblActKot')).toBeVisible();
  32 |     await expect(page.locator('#tblActBill')).toBeVisible();
  33 |     await page.click('#tblActClose');
  34 |     // No KOTs on it, so a plain confirmation is enough; cancelling keeps the table occupied
  35 |     await expect(page.locator('#confirmOk')).toBeVisible();
  36 |     await page.click('#confirmCancel');
  37 |     await expect(page.locator('#modal')).toBeHidden();
  38 |     await expect(tile.locator('span').first()).toHaveText('OCCUPIED');
  39 |   });
  40 | 
  41 |   test('Journey 6: Day Closing Reconciliation Submission (Owner/Manager role)', async ({ page }) => {
  42 |     // Use a past business date (2 days ago) to avoid conflicting with the
  43 |     // owner-branch-closing.spec.ts test which closes today's date on the same
  44 |     // in-memory PGlite database used for the full E2E suite.
  45 |     const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  46 |       .toISOString()
  47 |       .slice(0, 10); // YYYY-MM-DD
  48 | 
  49 |     // 1. Login as Manager
  50 |     await page.fill('#loginEmail', 'manager@liquor.com');
  51 |     await page.fill('#loginPass', 'Password@123');
  52 |     await page.click('button:has-text("Sign In")');
  53 | 
  54 |     // 2. Navigate to Day Closing view
  55 |     await page.click('#nav-closing');
  56 |     await expect(page.locator('#page-closing')).toBeVisible();
  57 | 
  58 |     // 3. Set business date to 2 days ago so it doesn't collide with today's closing
  59 |     await page.fill('#closingDate', past);
  60 | 
  61 |     // 4. Enter cash values
  62 |     await page.fill('#closingOpeningCash', '5000.00');
  63 |     await page.fill('#closingActualCash', '5000.00');
  64 |     await page.fill('#closingWithdrawals', '0.00');
  65 | 
  66 |     // Handle the browser alert dialog automatically
  67 |     page.once('dialog', dialog => dialog.accept());
  68 | 
  69 |     // 5. Submit
  70 |     await page.click('#btnSubmitClosing');
  71 |     // Locking the day asks for an in-page confirmation first
  72 |     await expect(page.locator('#modalTitle')).toContainText('Close day');
  73 |     await page.click('#confirmOk');
  74 | 
  75 |     // 6. Verify success message
> 76 |     await expect(page.locator('#closingStatusMsg')).toContainText('Day Closed & Locked', { timeout: 10000 });
     |                                                     ^ Error: expect(locator).toContainText(expected) failed
  77 |   });
  78 | });
  79 | 
```