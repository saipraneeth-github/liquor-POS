import { test, expect } from '@playwright/test';
import { apiPost, apiToken, login, uniq } from './helpers';

test('owner picks a branch (persisted across reload) and closes the day for it', async ({ page, request }) => {
  // A second branch in the owner's syndicate so the picker has a real choice
  const token = await apiToken(request, 'owner@liquor.com');
  const code = 'Z' + uniq().slice(-6);
  await apiPost(request, token, '/branches', { name: `E2E Branch ${code}`, code });

  await login(page, 'owner@liquor.com');
  const picker = page.locator('#branchSelect');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).not.toHaveCount(1);

  // Pick the new branch, then switch to MAIN-01 — the choice must survive a reload
  await picker.selectOption({ label: `${code} — E2E Branch ${code}` });
  await expect(page.locator('#sidebarBranch')).toContainText(code);
  await picker.selectOption({ label: 'MAIN-01 — Main Counter Branch' });
  await expect(page.locator('#sidebarBranch')).toContainText('MAIN-01');
  await page.reload();
  await expect(page.locator('#mainApp')).toBeVisible();
  await expect(page.locator('#sidebarBranch')).toContainText('MAIN-01');
  const mainId = await page.locator('#branchSelect').inputValue();

  // Close the day for the selected branch
  await page.click('#nav-closing');
  await page.fill('#closingOpeningCash', '2000.00');
  await page.fill('#closingActualCash', '2000.00');
  await page.fill('#closingWithdrawals', '0');
  await page.click('#btnSubmitClosing');
  await expect(page.locator('#modalTitle')).toContainText('Close day');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/closing') && r.request().method() === 'POST'),
    page.click('#confirmOk'),
  ]);
  expect(resp.status()).toBe(201);
  expect(resp.request().postDataJSON().branchId).toBe(mainId);
  await expect(page.locator('#closingStatusMsg')).toContainText('Day Closed & Locked');
  await expect(page.locator('#closingHistory table')).toBeVisible();
});
