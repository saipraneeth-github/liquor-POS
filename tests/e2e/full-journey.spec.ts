import { test, expect } from '@playwright/test';

test.describe('End-to-End Liquor Counter Application Journeys', () => {
  test.beforeEach(async ({ page }) => {
    // Listen for uncaught browser errors and console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error(`Browser console error: "${msg.text()}"`);
      }
    });
    page.on('pageerror', err => {
      console.error(`Uncaught page exception: "${err.message}"`);
    });
    await page.goto('/');
  });

  test('Journey 1: Public Login & Role-based authentication', async ({ page }) => {
    // 1. Verify Login Page visible
    const loginPage = page.locator('#loginPage');
    await expect(loginPage).toBeVisible();

    // 2. Perform Login with seeded cashier credentials
    await page.fill('#loginEmail', 'cashier@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    // 3. Verify transition to Main App
    const mainApp = page.locator('#mainApp');
    await expect(mainApp).toBeVisible({ timeout: 10000 });

    // 4. Check user info display
    const userDisplay = page.locator('#userDisplay');
    await expect(userDisplay).toContainText('cashier');
  });

  test('Journey 2: Catalog Loading & Real Database Products', async ({ page }) => {
    // Login
    await page.fill('#loginEmail', 'cashier@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    // Switch to POS page
    await page.click('#nav-pos');
    await expect(page.locator('#page-pos')).toBeVisible();

    // Check that products rendered in POS grid
    const productCards = page.locator('.pos-product');
    await expect(productCards.first()).toBeVisible({ timeout: 10000 });
    const count = await productCards.count();
    expect(count).toBeGreaterThan(0);
    console.log(`Rendered ${count} products in catalog.`);
  });

  test('Journey 3: POS Cart addition, pricing calculation & Checkout', async ({ page }) => {
    // Login
    await page.fill('#loginEmail', 'cashier@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    await page.click('#nav-pos');

    // Add first product to cart
    const firstProduct = page.locator('.pos-product').first();
    await firstProduct.click();

    // Verify cart reflects addition
    const cartItems = page.locator('#cartItems');
    await expect(cartItems).not.toContainText('Add products to start billing');

    // Verify total is updated
    const totalAmount = page.locator('#totalAmount');
    await expect(totalAmount).toBeVisible();
    const totalText = await totalAmount.innerText();
    expect(totalText).not.toBe('₹0.00');

    // Click Checkout
    const checkoutBtn = page.locator('button[onclick="checkout()"]');
    await expect(checkoutBtn).toBeVisible();
    await checkoutBtn.click();

    // Verify Checkout Modal appears with confirmation
    const checkoutModal = page.locator('#checkoutModal');
    await expect(checkoutModal).toBeVisible({ timeout: 10000 });

    // Check summary text contains Bill No or confirmation
    const summary = page.locator('#checkoutSummary');
    await expect(summary).toContainText('collected via CASH');
  });

  test('Journey 4: Navigation across modules without JS crashes', async ({ page }) => {
    await page.fill('#loginEmail', 'cashier@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    // Cashier-level screens are reachable…
    const navTabs = ['dashboard', 'pos', 'shift', 'bills', 'customers', 'tables', 'products', 'stock', 'counter'];
    for (const tab of navTabs) {
      await page.click(`#nav-${tab}`);
      await expect(page.locator(`#page-${tab}`)).toBeVisible();
    }
    // …manager-only screens are not offered to a cashier
    for (const tab of ['schemes', 'compliance', 'accounting', 'closing', 'admin']) {
      await expect(page.locator(`#nav-${tab}`)).toHaveCount(0);
    }
  });
});
