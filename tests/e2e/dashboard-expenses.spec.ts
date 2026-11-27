import { test, expect } from '@playwright/test';
import { login } from './helpers';

for (const role of ['manager', 'owner', 'officeadmin', 'cashier']) {
  test(`${role} records an expense from the dashboard`, async ({ page }) => {
    await login(page, `${role}@liquor.com`);
    await page.goto('/dashboard');
    await page.locator('#dashRecordExpense').click();
    if (role === 'owner') {
      await expect(page.locator('#expBranch')).toHaveValue('');
      await page.locator('#expBranch').selectOption({ index: 1 });
    }
    await page.locator('#expCategory').selectOption('Tea');
    await page.keyboard.press('F2');
    await expect(page.locator('#expenseForm')).toBeVisible();
    await page.locator('#expAmount').fill('0');
    await page.locator('#expSave').click();
    await expect(page.locator('#expenseError')).toContainText('above zero');
    await page.locator('#expAmount').fill('87.50');
    const response = page.waitForResponse(r => r.url().includes('/api/v1/expenses/') && r.request().method() === 'POST');
    await page.locator('#expSave').click();
    expect((await response).status()).toBe(201);
    await expect(page.locator('dialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Expense recorded' })).toBeVisible();
    await expect(page.locator('#page-dashboard')).toBeVisible();
  });
}

test('stewards do not get the expense action', async ({ page }) => {
  await login(page, 'steward@liquor.com');
  await page.goto('/dashboard');
  await expect(page.locator('#page-dashboard')).toBeVisible();
  await expect(page.locator('#dashRecordExpense')).toHaveCount(0);
});

test('a failed save keeps expense details for correction or retry', async ({ page }) => {
  await login(page, 'cashier@liquor.com');
  await page.goto('/dashboard');
  await page.locator('#dashRecordExpense').click();
  await page.locator('#expCategory').selectOption('Transport');
  await page.locator('#expAmount').fill('250.25');
  await page.locator('#expNotes').fill('Delivery trip');
  await page.route('**/api/v1/expenses/*', route => route.fulfill({ status: 503, json: { error: 'Please try again shortly.' } }));
  await page.locator('#expSave').click();
  await expect(page.locator('#expenseError')).toContainText('Please try again shortly.');
  await expect(page.locator('#expAmount')).toHaveValue('250.25');
  await expect(page.locator('#expNotes')).toHaveValue('Delivery trip');
  await expect(page.locator('#expSave')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('accounting and expense popup fit a phone in all languages, with retry and keyboard close', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, 'manager@liquor.com');
  await page.goto('/accounting');
  if (await page.locator('#sidebarCloseBtn').isVisible()) await page.locator('#sidebarCloseBtn').click();
  await expect(page.locator('#cashBook')).toBeVisible();
  for (const lang of ['en', 'hi', 'te']) {
    await page.locator('#languageSelect').selectOption(lang);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await page.locator('#accountingRecordExpense').click();
    await expect(page.locator('#expAmount')).toBeFocused();
    await expect(page.locator('#expSave')).toHaveText({ en: 'Save expense', hi: 'खर्च सेव करें', te: 'ఖర్చును సేవ్ చేయండి' }[lang]!);
    expect(await page.locator('dialog > div').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/expense-${lang}-360.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator('#languageSelect').selectOption('en');
  await page.route('**/api/v1/accounting/trial-balance/*', route => route.fulfill({ status: 500, json: { error: 'Unavailable' } }));
  await page.locator('nav[aria-label="Accounting"] select').selectOption('tb');
  await expect(page.getByRole('alert')).toContainText('Could not load this report');
  await page.unroute('**/api/v1/accounting/trial-balance/*');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('#tbStatus')).toContainText('Balanced');
  await page.screenshot({ path: 'test-results/accounting-report-360.png', fullPage: true });
});
