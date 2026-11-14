# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: accounting-and-roles.spec.ts >> role gating: steward cannot see accounting or billing; cashier cannot open manager screens
- Location: tests\e2e\accounting-and-roles.spec.ts:29:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#userDisplay')
Expected substring: "steward"
Received string:    "Floor Steward (Steward)"
Timeout: 15000ms

Call log:
  - Expect "toContainText" locator('#userDisplay') with timeout 15000ms
  - waiting for locator('#userDisplay')
    33 × locator resolved to <div id="userDisplay" class="font-semibold">Floor Steward (Steward)</div>
       - unexpected value "Floor Steward (Steward)"

```

```yaml
- text: Floor Steward (Steward)
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { addProduct, checkoutAndGetBillNo, login } from './helpers';
  3  | 
  4  | test('accounting: trial balance is balanced after sales; P&L and Tally export work', async ({ page }) => {
  5  |   await login(page, 'manager@liquor.com');
  6  |   await addProduct(page, 'Royal Challenge');
  7  |   await checkoutAndGetBillNo(page);
  8  | 
  9  |   await page.click('#nav-accounting');
  10 |   await expect(page.locator('#acctab-tb')).toHaveAttribute('aria-selected', 'true');
  11 |   await expect(page.locator('#tbStatus')).toContainText('Balanced ✓');
  12 |   const dr = await page.locator('#tbDebit').innerText();
  13 |   const cr = await page.locator('#tbCredit').innerText();
  14 |   expect(dr).toBe(cr);
  15 |   expect(dr).not.toBe('₹0.00');
  16 | 
  17 |   await page.click('#acctab-pl');
  18 |   await expect(page.locator('#plNet')).toBeVisible();
  19 | 
  20 |   await page.click('#acctab-bs');
  21 |   await expect(page.locator('#bsStatus')).toContainText('Balanced');
  22 | 
  23 |   await page.click('#acctab-tally');
  24 |   const [download] = await Promise.all([page.waitForEvent('download'), page.click('#tallyDownloadBtn')]);
  25 |   expect(download.suggestedFilename()).toMatch(/\.xml$/);
  26 |   await expect(page.locator('#tallyResult')).toContainText('Downloaded');
  27 | });
  28 | 
  29 | test('role gating: steward cannot see accounting or billing; cashier cannot open manager screens', async ({ page }) => {
  30 |   await login(page, 'steward@liquor.com');
> 31 |   await expect(page.locator('#userDisplay')).toContainText('steward');
     |                                              ^ Error: expect(locator).toContainText(expected) failed
  32 |   await expect(page.locator('#nav-dashboard')).toBeVisible();
  33 |   for (const tab of ['accounting', 'pos', 'bills', 'closing', 'admin', 'schemes']) {
  34 |     await expect(page.locator(`#nav-${tab}`)).toHaveCount(0);
  35 |   }
  36 |   // Typing the address of a manager screen is refused with a visible message, and the steward is sent back to the dashboard
  37 |   await page.goto('/accounting');
  38 |   await expect(page.locator('#toastHost')).toContainText('cannot open Accounting');
  39 |   await expect(page.locator('#page-accounting')).toHaveCount(0);
  40 |   await expect(page.locator('#page-dashboard')).toBeVisible();
  41 | 
  42 |   // Stewards do table service: Tables & KOT is reachable and lists the branch tables
  43 |   await expect(page.locator('#nav-tables')).toBeVisible();
  44 |   await page.click('#nav-tables');
  45 |   await expect(page.locator('#page-tables')).toBeVisible();
  46 |   await expect(page.locator('.table-tile').first()).toBeVisible({ timeout: 10000 });
  47 |   await expect(page.locator('#page-tables .mgr-only')).toBeHidden();
  48 | 
  49 |   await page.click('button:has-text("Sign out")');
  50 |   await expect(page.locator('#loginPage')).toBeVisible();
  51 |   await login(page, 'cashier@liquor.com');
  52 |   await expect(page.locator('#nav-pos')).toBeVisible();
  53 |   await expect(page.locator('#nav-accounting')).toHaveCount(0);
  54 |   await expect(page.locator('#nav-closing')).toHaveCount(0);
  55 | });
  56 | 
  57 | test('expired or invalid session returns to the login page with a message', async ({ page }) => {
  58 |   await login(page, 'cashier@liquor.com');
  59 |   // Replace the stored token with one the server rejects, then reload (session restore → 401)
  60 |   await page.evaluate(() => {
  61 |     localStorage.setItem('token', 'x.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAifQ.y');
  62 |   });
  63 |   await page.reload();
  64 |   await expect(page.locator('#loginPage')).toBeVisible();
  65 |   await expect(page.locator('#loginError')).toContainText('session has expired');
  66 | });
  67 | 
```