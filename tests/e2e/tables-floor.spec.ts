/**
 * The redesigned Tables floor: an occupied table shows what it has spent, who serves it and what is waiting; tables can
 * be moved and merged; a table is billed from its tile with cash tender and change.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect } from '@playwright/test';
import { apiGet, apiPost, apiToken, login, uniq } from './helpers';

type Product = { id: string; mrp: string; trackStock?: boolean; currentStock?: number; stockQuantity?: number; servings?: unknown[]; isAvailable?: boolean };
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test('Tables: the bill is on the tile; move a party, merge two tables, bill with change', async ({ page, request }) => {
  test.setTimeout(150_000);
  const manager = await apiToken(request, 'manager@liquor.com');
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const steward = await apiToken(request, 'steward@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const products = await apiGet<Product[]>(request, manager, `/products?branchId=${me.branchId}`);
  const bottle = products.find((p) => p.trackStock !== false && (p.currentStock ?? p.stockQuantity ?? 0) >= 6 && !(p.servings as unknown[] | undefined)?.length && p.isAvailable !== false)!;
  expect(bottle).toBeTruthy();
  const price = Number(bottle.mrp);

  const stamp = uniq();
  const names = { a: `FA ${stamp}`, b: `FB ${stamp}`, c: `FC ${stamp}` };
  const make = async (name: string) => (await apiPost<{ table: { id: string } }>(request, manager, `/tables/${me.branchId}`, { name, capacity: 4, section: 'Floor test' })).table.id;
  const ids = { a: await make(names.a), b: await make(names.b), c: await make(names.c) };
  const open = async (id: string) => (await apiPost<{ session: { id: string } }>(request, cashier, `/tables/${id}/open`, { branchId: me.branchId, guestCount: 2 })).session.id;
  const sessA = await open(ids.a);
  const sessB = await open(ids.b);
  const order = (sessionId: string, quantity: number) =>
    apiPost(request, steward, '/kot', { tableSessionId: sessionId, branchId: me.branchId, destination: 'BAR', items: [{ productId: bottle.id, quantity }] });
  await order(sessA, 2);
  await order(sessB, 1);

  await login(page, 'cashier@liquor.com');
  await page.click('#nav-tables');
  const tile = (name: string) => page.locator(`.table-tile[data-table="${name}"]`);

  // The bill is on the tile: no need to open it
  await expect(tile(names.a)).toBeVisible({ timeout: 10000 });
  await expect(page.locator(`[data-bill="${names.a}"]`)).toHaveText(`₹${inr(price * 2)}`);
  await expect(tile(names.a)).toContainText('2 items ordered');
  await expect(page.locator(`[data-toserve="${names.a}"]`)).toContainText('2 to serve');
  await expect(tile(names.a)).toContainText('OCCUPIED');
  await expect(page.locator('#sumOpenTotal')).not.toHaveText('₹0.00');
  await expect(tile(names.c)).toContainText('FREE');
  await expect(page.locator(`[data-bill="${names.c}"]`)).toHaveCount(0);                       // a free table has no bill

  // Show only some tables
  await page.fill('#tablesSearch', stamp);
  await page.click('[data-view="FREE"]');
  await expect(tile(names.c)).toBeVisible();
  await expect(tile(names.a)).toHaveCount(0);
  await page.click('[data-view="OCCUPIED"]');
  await expect(tile(names.a)).toBeVisible();
  await expect(tile(names.c)).toHaveCount(0);
  await page.click('[data-view="ALL"]');
  await page.fill('#tablesSearch', '');

  // The actions dialog opens with the bill so far
  await tile(names.a).click();
  await expect(page.locator('#tblSummaryTotal')).toHaveText(`₹${inr(price * 2)}`);

  // Move the party to the free table: the bill goes with them
  await page.click('#tblActMove');
  await page.click(`[data-move-to="${names.c}"]`);
  await expect(page.locator('#toastHost')).toContainText(`${names.a} moved to ${names.c}`);
  await expect(tile(names.a)).toContainText('FREE');
  await expect(tile(names.c)).toContainText('OCCUPIED');
  await expect(page.locator(`[data-bill="${names.c}"]`)).toHaveText(`₹${inr(price * 2)}`);

  // Merge the other table into it: one bill
  await tile(names.b).click();
  await page.click('#tblActMerge');
  await page.click(`[data-merge-into="${names.c}"]`);
  await expect(page.locator('#toastHost')).toContainText('one bill');
  await expect(tile(names.b)).toContainText('FREE');
  await expect(page.locator(`[data-bill="${names.c}"]`)).toHaveText(`₹${inr(price * 3)}`);
  await expect(tile(names.c)).toContainText('3 items ordered');

  // Bill it from the tile: cash received and the change to give back
  await page.locator(`.table-tile[data-table="${names.c}"] [data-quick="bill"]`).click();
  await expect(page.locator('#coTender')).toBeVisible();
  const total = price * 3;
  await page.fill('#coReceived', '1');
  await expect(page.locator('#coChange')).toHaveAttribute('data-state', 'short');
  await expect(page.locator('#coConfirm')).toBeDisabled();
  await page.fill('#coReceived', String(total + 100));
  await expect(page.locator('#coChange')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#coChange')).toContainText('100.00');
  await page.click('#coConfirm');
  await expect(page.locator('#checkoutDone')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#coChangeDone')).toContainText('100.00');
  await page.click('#coDone');
  await expect(tile(names.c)).toContainText('FREE');
});

test('Tables: a steward can move a table but not merge or bill; the floor works on a phone', async ({ page, request }) => {
  const manager = await apiToken(request, 'manager@liquor.com');
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const stamp = uniq();
  const a = `SA ${stamp}`;
  const idA = (await apiPost<{ table: { id: string } }>(request, manager, `/tables/${me.branchId}`, { name: a })).table.id;
  await apiPost(request, manager, `/tables/${me.branchId}`, { name: `SB ${stamp}` });
  await apiPost(request, cashier, `/tables/${idA}/open`, { branchId: me.branchId });

  await login(page, 'steward@liquor.com');
  await page.click('#nav-tables');
  await page.locator(`.table-tile[data-table="${a}"]`).click();
  await expect(page.locator('#tblActMove')).toBeVisible();
  await expect(page.locator('#tblActMerge')).toHaveCount(0);
  await expect(page.locator('#tblActBill')).toHaveCount(0);
  await page.click('#tblActDoneBtn');
  await expect(page.locator(`.table-tile[data-table="${a}"] [data-quick="bill"]`)).toHaveCount(0);
  await expect(page.locator(`.table-tile[data-table="${a}"] [data-quick="order"]`)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  const tile = page.locator(`.table-tile[data-table="${a}"]`);
  await expect(tile).toBeVisible();
  const box = await tile.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(box!.width).toBeGreaterThan(300);                                                  // one tile per row, full width
});
