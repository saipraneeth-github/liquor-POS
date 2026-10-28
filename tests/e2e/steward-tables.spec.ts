import { test, expect } from '@playwright/test';
import { apiGet, apiPost, apiToken, login, uniq } from './helpers';

test('steward: sees an occupied table, raises a KOT and moves an item along the allowed status flow', async ({ page, request }) => {
  // Setup (not under test): a fresh table opened by the cashier
  const manager = await apiToken(request, 'manager@liquor.com');
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const name = 'Stw ' + uniq();
  const { table } = await apiPost<{ table: { id: string } }>(request, manager, `/tables/${me.branchId}`, { name });
  await apiPost(request, cashier, `/tables/${table.id}/open`, { branchId: me.branchId });

  await login(page, 'steward@liquor.com');
  await page.click('#nav-tables');
  const tile = page.locator(`.table-tile[data-table="${name}"]`);
  await expect(tile).toBeVisible({ timeout: 10000 });
  await expect(tile).toContainText('OCCUPIED');

  // Occupied tile → KOT actions only (no billing / closing for a steward)
  await tile.click();
  await expect(page.locator('#tblActKot')).toBeVisible();
  await expect(page.locator('#tblActBill')).toHaveCount(0);
  await expect(page.locator('#tblActClose')).toHaveCount(0);

  await page.click('#tblActKot');
  await expect(page.locator('#modalTitle')).toContainText('New KOT');
  await expect(page.locator('.kot-product').first()).toHaveAttribute('aria-label', 'Product');
  await page.click('#kotCreateBtn');
  await expect(page.locator('#toastHost')).toContainText(`KOT sent to bar for ${name}`);

  // Re-open the KOT list; only server-allowed moves are offered
  await tile.click();
  await page.click('#tblActKots');
  const status = page.locator('#modalBody select').first();
  await expect(status).toHaveValue('PENDING');
  await expect(status.locator('option')).toHaveText(['PENDING', 'PREPARING', 'CANCELLED']);
  await status.selectOption('PREPARING');
  await expect(page.locator('#toastHost')).toContainText('Item marked PREPARING');
  await expect(page.locator('#modalBody select').first()).toHaveValue('PREPARING');
  await expect(page.locator('#modalBody select').first().locator('option')).toHaveText(['PREPARING', 'SERVED', 'CANCELLED']);
});

test('steward cannot open a free table from the tile', async ({ page, request }) => {
  const manager = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const name = 'StwFree ' + uniq();
  await apiPost(request, manager, `/tables/${me.branchId}`, { name });

  await login(page, 'steward@liquor.com');
  await page.click('#nav-tables');
  const tile = page.locator(`.table-tile[data-table="${name}"]`);
  await expect(tile).toBeVisible({ timeout: 10000 });
  await tile.click();
  await expect(page.locator('#toastHost')).toContainText('A cashier or manager opens tables');
  await expect(tile).toContainText('FREE');
});
