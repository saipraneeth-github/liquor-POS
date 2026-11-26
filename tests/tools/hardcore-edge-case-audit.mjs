import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = path.resolve('test-results/screenshots');

async function runEdgeCaseAudit() {
  console.log('================================================================');
  console.log('🔥 HARDCORE EDGE-CASE & STRESS TESTING (REAL BROWSER)');
  console.log('================================================================\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errorsFound = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`   🔴 [Console Error] ${msg.text()}`);
      errorsFound.push({ type: 'console', text: msg.text() });
    }
  });

  page.on('pageerror', (err) => {
    console.log(`   💥 [Page Crash] ${err.message}`);
    errorsFound.push({ type: 'crash', text: err.message });
  });

  // Login as manager
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#loginEmail', 'manager@liquor.com');
  await page.fill('#loginPass', 'Password@123');
  await page.click('#loginBtn');
  await page.waitForSelector('#mainApp', { timeout: 15000 });
  console.log('✓ Logged in as manager');

  // TEST 1: POS STRESS & INTERACTION
  console.log('\n--- 1. POS STRESS TESTING ---');
  await page.goto(`${BASE_URL}/pos`);
  await page.waitForTimeout(1000);

  // Search for beer / wine
  await page.fill('#posSearch', 'Wine');
  await page.waitForTimeout(500);

  // Click first available item
  const productCard = page.locator('.pos-product, [id^="posProduct-"]').first();
  if (await productCard.isVisible()) {
    await productCard.click();
    console.log('✓ Clicked product card');
    await page.waitForTimeout(400);

    // Increment quantity via + button
    const plusBtn = page.locator('#cartItems button:has-text("+"), .cart-qty-plus, button[aria-label="Increase"]').first();
    if (await plusBtn.isVisible()) {
      await plusBtn.click();
      await plusBtn.click();
      console.log('✓ Incremented cart quantity (+2)');
    }

    // Try discount 10%
    const discInput = page.locator('#posDiscount, input[placeholder*="Discount"]');
    if (await discInput.isVisible()) {
      await discInput.fill('10');
      console.log('✓ Applied 10% discount');
    }

    // Capture screenshot of populated cart
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'pos_populated_cart.png') });
  }

  // TEST 2: TABLES & BAR INTERACTION
  console.log('\n--- 2. TABLES & BAR INTERACTION ---');
  await page.goto(`${BASE_URL}/tables`);
  await page.waitForTimeout(1200);

  // Check if tables are listed
  const tableCards = page.locator('[data-table]');
  const tableCount = await tableCards.count();
  console.log(`✓ Tables detected: ${tableCount}`);
  if (tableCount > 0) {
    await tableCards.first().click();
    await page.waitForTimeout(800);
    console.log('✓ Opened first table');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'tables_selected.png') });
  }

  // TEST 3: BILLS VOID MODAL PROTECTED BUTTON TEST
  console.log('\n--- 3. BILLS VOID BUTTON & ROLE-PROTECTED ACTIONS ---');
  await page.goto(`${BASE_URL}/bills`);
  await page.waitForTimeout(1200);

  const voidBtn = page.locator('button:has-text("Void")').first();
  if (await voidBtn.isVisible()) {
    await voidBtn.click();
    console.log('✓ Clicked Protected Void Button — opened modal');
    await page.waitForTimeout(600);

    const voidReason = page.locator('#voidReason');
    if (await voidReason.isVisible()) {
      await voidReason.fill('Customer returned due to wrong pack size selected');
      console.log('✓ Filled void reason');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'bills_void_modal_protected.png') });

      // Click Cancel so we don't actually void real seed data
      const cancelBtn = page.locator('#modal button:has-text("Cancel")');
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
        console.log('✓ Cancelled void');
      }
    }
  }

  // TEST 4: INVENTORY TABS & EXPAND DETAILS
  console.log('\n--- 4. INVENTORY STEPPER & TABS ---');
  await page.goto(`${BASE_URL}/inventory`);
  await page.waitForTimeout(1200);

  // Check Stepper
  const stepButtons = page.locator('button:has-text("Upload"), button:has-text("Review"), button:has-text("Live Stock")');
  console.log(`✓ Stepper buttons: ${await stepButtons.count()}`);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'inventory_stepper.png') });

  // TEST 5: CLOSING SUMMARY STATS
  console.log('\n--- 5. DAILY CLOSING RECONCILIATION CARDS ---');
  await page.goto(`${BASE_URL}/closing`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daily_closing_summary.png') });
  console.log('✓ Captured daily closing summary');

  console.log('\n================================================================');
  console.log(`🏁 EDGE-CASE AUDIT COMPLETE. Issues found: ${errorsFound.length}`);
  console.log('================================================================');

  await browser.close();
}

runEdgeCaseAudit().catch(err => {
  console.error('Edge case audit error:', err);
  process.exit(1);
});
