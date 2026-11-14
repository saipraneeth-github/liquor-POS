# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard-login.spec.ts >> owner dashboard: all-outlets view and switch to a single outlet
- Location: tests\e2e\dashboard-login.spec.ts:33:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#dashTitle')
Expected substring: "All outlets"
Received string:    "Welcome to Main Counter Branch"
Timeout: 15000ms

Call log:
  - Expect "toContainText" locator('#dashTitle') with timeout 15000ms
  - waiting for locator('#dashTitle')
    33 × locator resolved to <h2 id="dashTitle">Welcome to Main Counter Branch</h2>
       - unexpected value "Welcome to Main Counter Branch"

```

```yaml
- heading "Welcome to Main Counter Branch" [level=2]
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | import { PASSWORD } from './helpers';
  3  | 
  4  | async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  5  |   await page.goto('/login');
  6  |   await page.fill('#loginEmail', email);
  7  |   await page.fill('#loginPass', password);
  8  |   await page.click('#loginBtn');
  9  | }
  10 | 
  11 | test('login: shows server status, reveals the password, and says how many tries are left', async ({ page }) => {
  12 |   await page.goto('/login');
  13 |   await expect(page.locator('#loginServerStatus')).toContainText(/reachable/i, { timeout: 15000 });
  14 |   await page.fill('#loginPass', 'secret-value');
  15 |   await expect(page.locator('#loginPass')).toHaveAttribute('type', 'password');
  16 |   await page.click('#loginShowPw');
  17 |   await expect(page.locator('#loginPass')).toHaveAttribute('type', 'text');
  18 | 
  19 |   await login(page, 'manager@liquor.com', 'definitely-wrong');
  20 |   await expect(page.locator('#loginError')).toContainText(/tries? left/i);
  21 | });
  22 | 
  23 | test('manager dashboard: figures, attention strip and New bill shortcut', async ({ page }) => {
  24 |   await login(page, 'manager@liquor.com');
  25 |   await expect(page.locator('#page-dashboard')).toBeVisible({ timeout: 15000 });
  26 |   await expect(page.locator('#dashSales')).toBeVisible({ timeout: 15000 });
  27 |   await expect(page.locator('#dashAttention')).toBeVisible();
  28 |   await expect(page.locator('#dashLoading')).toHaveCount(0);
  29 |   await page.click('#dashNewBill');
  30 |   await expect(page).toHaveURL(/\/pos$/);
  31 | });
  32 | 
  33 | test('owner dashboard: all-outlets view and switch to a single outlet', async ({ page }) => {
  34 |   await login(page, 'owner@liquor.com');
  35 |   const toggle = page.locator('#dashScope-all');
  36 |   // A syndicate owner may first be asked to pick a branch; the toggle appears once on the dashboard.
  37 |   await expect(toggle).toBeVisible({ timeout: 15000 });
> 38 |   await expect(page.locator('#dashTitle')).toContainText('All outlets');
     |                                            ^ Error: expect(locator).toContainText(expected) failed
  39 |   await page.click('#dashScope-branch');
  40 |   await expect(page.locator('#dashNewBill')).toBeVisible();
  41 | });
  42 | 
```