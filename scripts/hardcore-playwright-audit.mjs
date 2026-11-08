import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = path.resolve('test-results/screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const auditResults = [];

async function runHardcoreAudit() {
  console.log('================================================================');
  console.log('🚀 STARTING HARDCORE PLAYWRIGHT E2E AUDIT (REAL BROWSER)');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  console.log('================================================================\n');

  // Launch headed browser with slowMo so UI actions are visible
  const browser = await chromium.launch({
    headless: false,
    slowMo: 150, // Slight delay so UI transitions are visible
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Track console and network errors
  let pageConsoleErrors = [];
  let pageConsoleWarnings = [];
  let pageNetworkErrors = [];

  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      pageConsoleErrors.push(text);
      console.log(`   🔴 [Console Error] ${text.slice(0, 120)}`);
    } else if (msg.type() === 'warning') {
      pageConsoleWarnings.push(text);
    }
  });

  page.on('pageerror', (err) => {
    pageConsoleErrors.push(`Uncaught Exception: ${err.message}`);
    console.log(`   💥 [Page Crash / Error] ${err.message}`);
  });

  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('favicon.ico')) {
      const errInfo = `${res.status()} ${res.request().method()} ${res.url()}`;
      pageNetworkErrors.push(errInfo);
      console.log(`   ⚠️ [Network ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });

  function resetPageTracking() {
    pageConsoleErrors = [];
    pageConsoleWarnings = [];
    pageNetworkErrors = [];
  }

  async function auditPage(name, urlPath, preAction = null, postAction = null) {
    resetPageTracking();
    console.log(`\n🔍 AUDITING: ${name} (${urlPath})`);
    const startTime = Date.now();

    try {
      if (preAction) {
        await preAction();
      } else {
        await page.goto(`${BASE_URL}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }

      // Allow animations & lazy fetches to settle
      await page.waitForTimeout(1200);

      if (postAction) {
        await postAction();
        await page.waitForTimeout(800);
      }

      const screenshotFile = `page-${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.png`;
      const screenshotPath = path.join(SCREENSHOT_DIR, screenshotFile);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      const loadTime = Date.now() - startTime;
      const passed = pageConsoleErrors.length === 0 && pageNetworkErrors.filter(e => !e.startsWith('404')).length === 0;

      const record = {
        name,
        path: urlPath,
        loadTimeMs: loadTime,
        status: passed ? 'PASS' : 'WARN_OR_FAIL',
        consoleErrors: [...pageConsoleErrors],
        consoleWarnings: [...pageConsoleWarnings],
        networkErrors: [...pageNetworkErrors],
        screenshot: screenshotFile,
      };

      auditResults.push(record);
      console.log(`   ✅ Status: ${record.status} (${loadTime}ms) | Console Err: ${pageConsoleErrors.length} | Net Err: ${pageNetworkErrors.length}`);
    } catch (err) {
      console.log(`   ❌ Audit Failed for ${name}: ${err.message}`);
      auditResults.push({
        name,
        path: urlPath,
        status: 'CRASH',
        error: err.message,
        consoleErrors: [...pageConsoleErrors],
        networkErrors: [...pageNetworkErrors],
      });
    }
  }

  // 1. PUBLIC PAGES
  await auditPage('Login', '/login');
  await auditPage('Forgot Password', '/forgot-password');

  // 2. AUTHENTICATION & LOGIN AS MANAGER
  console.log('\n🔑 Logging in as manager@liquor.com...');
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#loginEmail', 'manager@liquor.com');
  await page.fill('#loginPass', 'Password@123');
  await page.click('#loginBtn');
  await page.waitForSelector('#mainApp', { timeout: 15000 });
  console.log('   ✓ Login successful, app shell loaded.');

  // 3. DASHBOARD
  await auditPage('Dashboard', '/');

  // Test Dark Mode toggle
  await auditPage('Dashboard_DarkMode', '/', null, async () => {
    const themeBtn = page.locator('#themeToggle');
    if (await themeBtn.isVisible()) {
      await themeBtn.click();
      console.log('   🌙 Dark mode toggled.');
      await page.waitForTimeout(500);
      await themeBtn.click(); // toggle back
    }
  });

  // Test Sidebar Collapse (Ctrl+B / Button)
  await auditPage('Dashboard_CollapsedSidebar', '/', null, async () => {
    const collapseBtn = page.locator('#sidebarCollapseBtn');
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
      console.log('   ↔ Sidebar collapsed.');
      await page.waitForTimeout(500);
      await collapseBtn.click(); // toggle back
    }
  });

  // 4. POS (Counter Billing)
  await auditPage('POS_Catalog', '/pos');

  // POS interactions: search item, add to cart
  await auditPage('POS_Cart_Interactions', '/pos', null, async () => {
    const searchInput = page.locator('#posSearch');
    if (await searchInput.isVisible()) {
      await searchInput.fill('Kingfisher');
      await page.waitForTimeout(600);
      // Click first product card if available
      const firstCard = page.locator('.pos-product, [id^="posProduct-"]').first();
      if (await firstCard.isVisible()) {
        await firstCard.click();
        console.log('   🛒 Added product to cart.');
      }
    }
  });

  // 5. SHIFT REGISTER
  await auditPage('Shift', '/shift');

  // 6. BILLS
  await auditPage('Bills', '/bills');

  // View Bill Modal test
  await auditPage('Bills_View_Modal', '/bills', null, async () => {
    const viewBtn = page.locator('button:has-text("View")').first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      console.log('   👁 Opened Bill View Modal.');
      await page.waitForTimeout(600);
      const closeBtn = page.locator('#modal button[aria-label="Close dialog"], #modal button:has-text("Close")').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      }
    }
  });

  // 7. CUSTOMERS / KHATA
  await auditPage('Customers_Khata', '/customers');

  // 8. TABLES & BAR KOT
  await auditPage('Tables_Bar', '/tables');

  // 9. PRODUCTS & CATALOG
  await auditPage('Products_Catalog', '/products');

  // 10. INVENTORY (TAB 1: Inward Bills, TAB 2: Invoices, TAB 3: Stock)
  await auditPage('Inventory_Inward_Tab', '/inventory');

  await auditPage('Inventory_Invoices_Tab', '/inventory', null, async () => {
    const tab2 = page.locator('button:has-text("Manage Bills"), button:has-text("Invoices"), #tabInvoices').first();
    if (await tab2.isVisible()) {
      await tab2.click();
      console.log('   📑 Switched to Invoices Tab.');
    }
  });

  await auditPage('Inventory_Store_Stock_Tab', '/inventory', null, async () => {
    const tab3 = page.locator('button:has-text("Store Stock"), #tabStock').first();
    if (await tab3.isVisible()) {
      await tab3.click();
      console.log('   📦 Switched to Store Stock Tab.');
    }
  });

  // 11. MENUS
  await auditPage('Kitchen_Menu', '/menu/kitchen');
  await auditPage('Bar_Menu', '/menu/bar');

  // 12. COUNTER SHEET
  await auditPage('Daily_Counter_Sheet', '/counter');

  // 13. SCHEMES
  await auditPage('Supplier_Schemes', '/schemes');

  // 14. COMPLIANCE & EXCISE
  await auditPage('Compliance_Excise', '/compliance');

  // 15. ACCOUNTING & LEDGER
  await auditPage('Accounting_Ledger', '/accounting');

  // 16. BANK RECONCILIATION
  await auditPage('Bank_Reconciliation', '/bank');

  // 17. CLOSING
  await auditPage('Daily_Closing', '/closing');

  // 18. ADMIN
  await auditPage('Admin_Settings', '/admin');

  // 19. POUR CONTROL
  await auditPage('Pour_Control', '/pour');

  // 20. BUSINESS SETTINGS
  await auditPage('Business_Settings', '/settings');

  // 21. PLATFORM (SUPER ADMIN)
  console.log('\n🔑 Switching to owner@liquor.com for Platform Super-Admin testing...');
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#loginEmail', 'owner@liquor.com');
  await page.fill('#loginPass', 'Password@123');
  await page.click('#loginBtn');
  await page.waitForSelector('#mainApp', { timeout: 15000 });
  console.log('   ✓ Login as owner successful.');

  await auditPage('Platform_Super_Admin', '/platform');

  console.log('\n================================================================');
  console.log('🏁 HARDCORE PLAYWRIGHT E2E AUDIT COMPLETE');
  console.log('================================================================');

  // Save report to JSON
  const reportPath = path.resolve('test-results/audit-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditResults, null, 2));
  console.log(`\nDetailed report written to: ${reportPath}`);

  // Summary counts
  const total = auditResults.length;
  const passed = auditResults.filter(r => r.status === 'PASS').length;
  const warned = auditResults.filter(r => r.status === 'WARN_OR_FAIL').length;
  const crashed = auditResults.filter(r => r.status === 'CRASH').length;

  console.log(`\nTotal Pages & States Audited: ${total}`);
  console.log(`✅ Clean Passes: ${passed}`);
  console.log(`⚠️ Warnings / Errors: ${warned}`);
  console.log(`❌ Crashes: ${crashed}\n`);

  await browser.close();
}

runHardcoreAudit().catch((err) => {
  console.error('Fatal audit failure:', err);
  process.exit(1);
});
