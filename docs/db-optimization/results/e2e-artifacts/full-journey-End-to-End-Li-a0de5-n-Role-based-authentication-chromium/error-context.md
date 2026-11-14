# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-journey.spec.ts >> End-to-End Liquor Counter Application Journeys >> Journey 1: Public Login & Role-based authentication
- Location: tests\e2e\full-journey.spec.ts:17:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#userDisplay')
Expected substring: "cashier"
Received string:    "Counter Cashier (Cashier)"
Timeout: 15000ms

Call log:
  - Expect "toContainText" locator('#userDisplay') with timeout 15000ms
  - waiting for locator('#userDisplay')
    33 × locator resolved to <div id="userDisplay" class="font-semibold">Counter Cashier (Cashier)</div>
       - unexpected value "Counter Cashier (Cashier)"

```

```yaml
- text: Counter Cashier (Cashier)
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | test.describe('End-to-End Liquor Counter Application Journeys', () => {
  4   |   test.beforeEach(async ({ page }) => {
  5   |     // Listen for uncaught browser errors and console errors
  6   |     page.on('console', msg => {
  7   |       if (msg.type() === 'error') {
  8   |         console.error(`Browser console error: "${msg.text()}"`);
  9   |       }
  10  |     });
  11  |     page.on('pageerror', err => {
  12  |       console.error(`Uncaught page exception: "${err.message}"`);
  13  |     });
  14  |     await page.goto('/');
  15  |   });
  16  | 
  17  |   test('Journey 1: Public Login & Role-based authentication', async ({ page }) => {
  18  |     // 1. Verify Login Page visible
  19  |     const loginPage = page.locator('#loginPage');
  20  |     await expect(loginPage).toBeVisible();
  21  | 
  22  |     // 2. Perform Login with seeded cashier credentials
  23  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  24  |     await page.fill('#loginPass', 'Password@123');
  25  |     await page.click('button:has-text("Sign In")');
  26  | 
  27  |     // 3. Verify transition to Main App
  28  |     const mainApp = page.locator('#mainApp');
  29  |     await expect(mainApp).toBeVisible({ timeout: 10000 });
  30  | 
  31  |     // 4. Check user info display
  32  |     const userDisplay = page.locator('#userDisplay');
> 33  |     await expect(userDisplay).toContainText('cashier');
      |                               ^ Error: expect(locator).toContainText(expected) failed
  34  |   });
  35  | 
  36  |   test('Journey 2: Catalog Loading & Real Database Products', async ({ page }) => {
  37  |     // Login
  38  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  39  |     await page.fill('#loginPass', 'Password@123');
  40  |     await page.click('button:has-text("Sign In")');
  41  | 
  42  |     // Switch to POS page
  43  |     await page.click('#nav-pos');
  44  |     await expect(page.locator('#page-pos')).toBeVisible();
  45  | 
  46  |     // Check that products rendered in POS grid
  47  |     const productCards = page.locator('.pos-product');
  48  |     await expect(productCards.first()).toBeVisible({ timeout: 10000 });
  49  |     const count = await productCards.count();
  50  |     expect(count).toBeGreaterThan(0);
  51  |     console.log(`Rendered ${count} products in catalog.`);
  52  |   });
  53  | 
  54  |   test('Journey 3: POS Cart addition, pricing calculation & Checkout', async ({ page }) => {
  55  |     // Login
  56  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  57  |     await page.fill('#loginPass', 'Password@123');
  58  |     await page.click('button:has-text("Sign In")');
  59  | 
  60  |     await page.click('#nav-pos');
  61  | 
  62  |     // Add first product to cart
  63  |     const firstProduct = page.locator('.pos-product').first();
  64  |     await firstProduct.click();
  65  | 
  66  |     // Verify cart reflects addition
  67  |     const cartItems = page.locator('#cartItems');
  68  |     await expect(cartItems).not.toContainText('Add products to start billing');
  69  | 
  70  |     // Verify total is updated
  71  |     const totalAmount = page.locator('#totalAmount');
  72  |     await expect(totalAmount).toBeVisible();
  73  |     const totalText = await totalAmount.innerText();
  74  |     expect(totalText).not.toBe('₹0.00');
  75  | 
  76  |     // Click Checkout
  77  |     const checkoutBtn = page.locator('#checkoutBtn');
  78  |     await expect(checkoutBtn).toBeVisible();
  79  |     await checkoutBtn.click();
  80  | 
  81  |     // Verify Checkout Modal appears with confirmation
  82  |     const checkoutModal = page.locator('#checkoutModal');
  83  |     await expect(checkoutModal).toBeVisible({ timeout: 10000 });
  84  | 
  85  |     // Check summary text contains Bill No or confirmation
  86  |     const summary = page.locator('#checkoutSummary');
  87  |     await expect(summary).toContainText('collected via CASH');
  88  |   });
  89  | 
  90  |   test('Journey 4: Navigation across modules without JS crashes', async ({ page }) => {
  91  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  92  |     await page.fill('#loginPass', 'Password@123');
  93  |     await page.click('button:has-text("Sign In")');
  94  | 
  95  |     // Cashier-level screens are reachable…
  96  |     // [menu item, id of the page it opens]
  97  |     const navTabs: Array<[string, string]> = [
  98  |       ['dashboard', 'dashboard'], ['pos', 'pos'], ['shift', 'shift'], ['bills', 'bills'], ['customers', 'customers'],
  99  |       ['tables', 'tables'], ['products', 'products'], ['inventory', 'stock'], ['counter', 'counter'],
  100 |     ];
  101 |     for (const [nav, pageId] of navTabs) {
  102 |       await page.click(`#nav-${nav}`);
  103 |       await expect(page.locator(`#page-${pageId}`)).toBeVisible();
  104 |     }
  105 |     // …manager-only screens are not offered to a cashier
  106 |     for (const tab of ['schemes', 'compliance', 'accounting', 'closing', 'admin']) {
  107 |       await expect(page.locator(`#nav-${tab}`)).toHaveCount(0);
  108 |     }
  109 |   });
  110 | });
  111 | 
```