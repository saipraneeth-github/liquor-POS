import { test, expect } from '@playwright/test';
import { addProduct, login } from './helpers';

test('offline bill is queued, auto-synced on reconnect and recorded exactly once', async ({ page, context }) => {
  await login(page, 'cashier@liquor.com');
  await addProduct(page, 'Blenders Pride');

  // Lose the network and ring the bill
  await context.setOffline(true);
  await page.click('#checkoutBtn');
  await expect(page.locator('#checkoutTitle')).toHaveText('Saved offline');
  await page.click('#newBillBtn');
  const indicator = page.locator('#offlineIndicator');
  await expect(indicator).toContainText('Offline');
  await expect(indicator).toContainText('1 bill queued');

  // Simulate a duplicated retry of the same bill (same clientRef) — the server must dedupe it
  // The queue is stored per user ('lc_offline_bills:<sub>') and every item records its owner
  const ref = await page.evaluate(() => {
    const key = (window as unknown as { queueKey: () => string }).queueKey();
    if (!key.startsWith('lc_offline_bills:')) throw new Error('queue is not per-user: ' + key);
    const q = JSON.parse(localStorage.getItem(key) || '[]');
    if (!q[0].ownerSub) throw new Error('queued bill has no owner');
    q.push({ ...q[0] });
    localStorage.setItem(key, JSON.stringify(q));
    (window as unknown as { renderOffline: () => void }).renderOffline();
    return q[0].clientRef as string;
  });
  expect(ref).toMatch(/^[0-9a-f-]{36}$/);
  await expect(indicator).toContainText('2 bills queued');

  // Back online → automatic sync (online event / interval)
  await context.setOffline(false);
  await expect(page.locator('#lastSync')).toContainText('duplicate submission ignored', { timeout: 35000 });
  await expect(indicator).toBeHidden({ timeout: 25000 });
  const syncText = await page.locator('#lastSync').innerText();
  const billNo = /Last offline sync: (\S+)/.exec(syncText)![1];
  // The duplicate was answered as a replay of the same bill (HTTP 200), not a second sale
  expect(syncText).toContain('duplicate submission ignored');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem((window as unknown as { queueKey: () => string }).queueKey()) || '[]').length)).toBe(0);

  // Exactly one bill exists for that number
  await page.click('#nav-bills');
  await page.fill('#billsSearch', billNo);
  await expect(page.locator(`tr.bill-row[data-bill-number="${billNo}"]`)).toHaveCount(1);
  await page.fill('#billsSearch', '');
  await expect(page.locator('tr.bill-row').first()).toBeVisible();
  await expect(page.locator(`tr.bill-row[data-bill-number="${billNo}"]`)).toHaveCount(1);
});

test('offline bills stay with the cashier who rang them: the next user to sign in does not submit them', async ({ page, context }) => {
  await login(page, 'cashier@liquor.com');
  await addProduct(page, 'Blenders Pride');
  await context.setOffline(true);
  await page.click('#checkoutBtn');
  await expect(page.locator('#checkoutTitle')).toHaveText('Saved offline');
  await expect(page.locator('#checkoutHistoryBtn')).toHaveText('View pending');
  await page.click('#checkoutHistoryBtn');
  await expect(page.locator('#billsPending')).toContainText('Pending sync');
  const cashierKey = await page.evaluate(() => (window as unknown as { queueKey: () => string }).queueKey());

  // Signing out warns about the unsynced bill (in-page confirmation) and keeps it on the device
  await page.click('button:has-text("Sign out")');
  await expect(page.locator('#modalTitle')).toContainText('unsynced bills');
  await page.click('#confirmOk');
  await expect(page.locator('#loginPage')).toBeVisible();

  await context.setOffline(false);
  await login(page, 'manager@liquor.com');
  // Give the manager session time to run its sync pass; the cashier's bill must stay queued and untouched
  await page.waitForTimeout(3000);
  const state = await page.evaluate((k) => ({
    cashier: JSON.parse(localStorage.getItem(k) || '[]').length,
    manager: JSON.parse(localStorage.getItem((window as unknown as { queueKey: () => string }).queueKey()) || '[]').length,
  }), cashierKey);
  expect(state).toEqual({ cashier: 1, manager: 0 });
  await expect(page.locator('#lastSync')).toHaveText('');
});
