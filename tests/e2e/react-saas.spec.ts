/**
 * Journeys through the React app (served from dist/frontend, entered at /login):
 * Kitchen menu, Bar menu + peg billing, table checkout, printer settings, pour control and the
 * Super Admin console. Build the frontend first: `npm run build:frontend`.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { apiGet, apiPost, apiToken, PASSWORD, uniq } from './helpers';

test.describe.configure({ mode: 'serial' });

async function reactLogin(page: Page, email: string, password = PASSWORD): Promise<void> {
  page.on('pageerror', (err) => console.error(`Uncaught page exception: "${err.message}"`));
  await page.goto('/login');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', password);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

const stamp = uniq();

/** Other specs ring bills in parallel, so find the receipt by its content rather than by recency. */
async function findReceipt(request: APIRequestContext, token: string, branchId: string, needle: string): Promise<string> {
  const { bills } = await apiGet<{ bills: { id: string }[] }>(request, token, `/bills?branchId=${branchId}&limit=30`);
  for (const b of bills) {
    const text = await (await request.get(`/api/v1/print/bills/${b.id}?format=text`, { headers: { Authorization: `Bearer ${token}` } })).text();
    if (text.includes(needle)) return text;
  }
  throw new Error(`No receipt containing "${needle}"`);
}
/** Demo bottle from the seed: 6 sealed bottles, servings 30/60/90 ml (260 for 60 ml) and a full-bottle rate. */
const BAR = 'House Blend Whisky 750ml';

test.beforeAll(async ({ request }) => {
  const res = await request.get('/login', { headers: { Accept: 'text/html' } });
  const html = await res.text();
  test.skip(!html.includes('id="root"'), 'React build not found — run `npm run build:frontend` first');
});

test('Kitchen Menu: add a dish, change its rate, see history, switch availability, delete', async ({ page }) => {
  const name = `Dish ${stamp}`;
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-menu-kitchen');
  await expect(page.locator('#page-menu-kitchen')).toBeVisible();

  await page.click('#menuAddBtn');
  await page.fill('#menuName', name);
  await page.fill('#menuCategory', 'Starters');
  await page.fill('#menuGst', '5');
  await page.fill('#menuPrice', '180');
  await page.fill('#menuHsn', '9963');
  await page.click('#menuSaveBtn');

  const row = page.locator(`.menu-row[data-item-name="${name}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('₹180.00');
  await expect(row).toContainText('5%');

  // change the rate
  await row.getByText('Edit', { exact: true }).click();
  await page.fill('#menuPrice', '195');
  await page.click('#menuSaveBtn');
  await expect(row).toContainText('₹195.00');

  // history shows both rates
  await row.getByText('Rate history').click();
  await expect(page.locator('[role=dialog]')).toContainText('₹195.00');
  await expect(page.locator('[role=dialog]')).toContainText('₹180.00');
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('[role=dialog] button[aria-label=Close]').click();

  // out of stock (for this branch)
  await row.getByRole('button', { name: 'In stock' }).click();
  await expect(row.getByRole('button', { name: 'Out of stock' })).toBeVisible();
  await expect(row).toContainText('this branch only');

  // delete
  await row.getByText('Delete', { exact: true }).click();
  await page.click('#menuDeleteOk');
  await expect(row).toHaveCount(0);
});

test('Bar Menu + POS: configure pegs, sell a 60 ml peg, stock shows the open bottle, receipt carries CGST/SGST', async ({ page, request }) => {
  const name = `Malt ${stamp}`;
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-menu-bar');

  await page.click('#menuAddBtn');
  await page.fill('#menuName', name);
  await page.fill('#menuCategory', 'Whisky');
  await page.fill('#menuGst', '18');
  await page.fill('#menuPrice', '3000');
  await page.fill('#menuVolume', '750');
  await page.getByRole('button', { name: '+ 60 ml' }).click();
  await page.getByRole('button', { name: '+ 90 ml' }).click();
  await page.getByRole('button', { name: '+ Bottle' }).click();
  const rates = page.locator('.serving-row input[placeholder="Rate ₹"]');
  await rates.nth(0).fill('300');
  await rates.nth(1).fill('420');
  await page.click('#menuSaveBtn');

  const row = page.locator(`.menu-row[data-item-name="${name}"]`);
  await expect(row).toContainText('60 ml');
  await expect(row).toContainText('₹300.00');
  await expect(row).toContainText('₹420.00');
  await expect(row).toContainText('Full bottle');

  // POS as cashier, on the seeded bottle (it has stock)
  const mgr = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await reactLogin(page, 'cashier@liquor.com');
  await page.click('#nav-pos');
  await page.fill('#posSearch', BAR);
  await page.locator('.pos-product', { hasText: BAR }).click();
  await expect(page.locator('#servingPicker')).toBeVisible();
  await page.locator('.serving-option', { hasText: '60 ml' }).click();
  await expect(page.locator('.cart-line')).toContainText(BAR);
  await expect(page.locator('.cart-line')).toContainText('60 ml');
  await page.click('#checkoutBtn');
  await expect(page.locator('#checkoutBillNo')).toBeVisible();
  await expect(page.locator('#checkoutSummary')).toContainText('260.00');

  // receipt (GST split)
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const text = await findReceipt(request, cashier, me.branchId, `${BAR} (60 ml)`);
  expect(text).toContain(`${BAR} (60 ml)`);
  expect(text).toContain('CGST');
  expect(text).toContain('SGST');

  // inventory shows the opened bottle
  await page.click('#newBillBtn');
  await page.click('#nav-inventory');
  await page.getByRole('button', { name: /Current Store Stock/ }).click();
  await expect(page.locator('.open-ml').first()).toContainText('ml open');
});

test('Pour Control: record a count and see the shortage in the report', async ({ page, request }) => {
  const mgr = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  const stock = await apiGet<{ name: string; openMl: number }[]>(request, mgr, `/inventory/stock/${me.branchId}`);
  const open = stock.find((s) => s.name === BAR)!.openMl;
  expect(open).toBeGreaterThan(40);

  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-pour');
  await expect(page.locator('#page-pour')).toBeVisible();
  await page.selectOption('#pourProduct', { label: BAR });
  await expect(page.locator('#pourForm')).toContainText(`${open} ml`);
  await page.fill('#pourCounted', String(open - 40));
  await page.fill('input[placeholder^="e.g. end of night"]', 'e2e dip');
  await page.click('#pourSaveBtn');
  await expect(page.locator('#toastHost')).toContainText('shortage of 40 ml');
  const row = page.locator(`.pour-row[data-product="${BAR}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('-40');
});

test('Table checkout: KOT with a peg becomes one GST bill and frees the table', async ({ page, request }) => {
  const mgr = await apiToken(request, 'manager@liquor.com');
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  const bar = (await apiGet<{ items: { id: string; name: string; servings: { id: string; label: string }[] }[] }>(request, mgr, '/menu/bar'))
    .items.find((i) => i.name === BAR)!;
  const kitchen = (await apiGet<{ items: { id: string; name: string }[] }>(request, mgr, '/menu/kitchen')).items.find((i) => i.name === 'Paneer Tikka')!;
  const tableName = 'Chk ' + stamp;
  const { table } = await apiPost<{ table: { id: string } }>(request, mgr, `/tables/${me.branchId}`, { name: tableName });
  const { session } = await apiPost<{ session: { id: string } }>(request, cashier, `/tables/${table.id}/open`, { branchId: me.branchId });
  await apiPost(request, cashier, '/kot', {
    tableSessionId: session.id, branchId: me.branchId, destination: 'BAR',
    items: [{ productId: bar.id, servingId: bar.servings.find((s) => s.label === '60 ml')!.id, quantity: 2 }, { productId: kitchen.id, quantity: 1 }],
  });

  await reactLogin(page, 'cashier@liquor.com');
  await page.click('#nav-tables');
  const tile = page.locator(`.table-tile[data-table="${tableName}"]`);
  await expect(tile).toBeVisible({ timeout: 10000 });
  await tile.click();
  await page.click('#tblActBill');
  await page.selectOption('#coPayment', 'UPI');
  await page.fill('#coGstin', '29AAAAA0000A1Z5');
  await page.click('#coConfirm');
  await expect(page.locator('#coBillNo')).toBeVisible();
  await expect(page.locator('#checkoutDone')).toContainText('760.00');   // 2 x 260 + 240
  await page.click('#coDone');
  await expect(page.locator(`.table-tile[data-table="${tableName}"]`)).toContainText('FREE');

  // B2B buyer in another state: the printed bill uses IGST
  const text = await findReceipt(request, cashier, me.branchId, 'Buyer GSTIN: 29AAAAA0000A1Z5');
  expect(text).toContain('IGST');
});

test('Admin: set the branch printer and send a test ticket to it', async ({ page }) => {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => sock.on('data', (d) => received.push(d)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await reactLogin(page, 'owner@liquor.com');
    await expect(page.locator('#branchSelect')).toBeVisible();     // an Admin works in a chosen branch
    await page.click('#nav-settings');
    await expect(page.locator('#planCard')).toContainText('STANDARD');
    await expect(page.locator('#billingCard')).toContainText('In good standing');
    const row = page.locator('.branch-row', { hasText: 'MAIN-01' });
    await row.getByText('Edit', { exact: true }).click();
    await page.fill('#branchGstin', '36ABCDE1234F1Z5');
    await page.fill('#printerHost', '127.0.0.1');
    await page.fill('#printerPort', String(port));
    await page.selectOption('#paperWidth', '80mm');
    await page.click('#printerTestBtn');
    await expect(page.locator('#toastHost')).toContainText('Test ticket sent');
    await expect.poll(() => Buffer.concat(received).toString('latin1')).toContain('PRINTER TEST');
    await page.click('#branchSaveBtn');
    await expect(row).toContainText('36ABCDE1234F1Z5');
    await expect(row).toContainText(`127.0.0.1:${port}`);
  } finally {
    server.close();
  }
});

test('Super Admin: sees the platform console, adds a tenant, suspends it, and the tenant is locked out', async ({ page, request }) => {
  const tenant = `Bar ${stamp}`;
  const email = `admin.${stamp.toLowerCase()}@tenant.test`;
  await reactLogin(page, 'superadmin@liquor.com');
  await expect(page.locator('#page-platform')).toBeVisible();          // lands on the console
  await expect(page.locator('#nav-pos')).toHaveCount(0);               // no branch-level pages
  await expect(page.locator('#platformStats')).toContainText('Tenants');

  await page.click('#tenantAddBtn');
  await page.fill('#tenantName', tenant);
  await page.selectOption('#tenantPlan', 'STANDARD');
  await page.fill('#tenantAdminName', 'New Admin');
  await page.fill('#tenantAdminEmail', email);
  await page.fill('#tenantAdminPassword', 'Welcome#2026');
  await page.click('#tenantSaveBtn');

  const row = page.locator('.tenant-row', { hasText: tenant });
  await expect(row).toBeVisible();
  await expect(row).toContainText('STANDARD');
  await expect(row).toContainText('0');   // branches used

  // the new Admin can sign in
  const ok = await request.post('/api/v1/auth/login', { data: { email, password: 'Welcome#2026' } });
  expect(ok.status()).toBe(200);

  await row.getByText('Suspend', { exact: true }).click();
  await page.click('#tenantSuspendOk');
  await expect(row).toContainText('Suspended');
  const blocked = await request.post('/api/v1/auth/login', { data: { email, password: 'Welcome#2026' } });
  expect(blocked.status()).toBe(403);

  await row.getByText('Reactivate', { exact: true }).click();
  await expect(row).toContainText('Active');

  // billing: invoice the tenant and record the payment
  await row.locator('.tenant-billing').click();
  await page.click('#invoiceGenerateBtn');
  const inv = page.locator('.invoice-row').first();
  await expect(inv).toContainText('₹2,999.00');
  await expect(inv).toContainText('PENDING');
  await inv.locator('input[placeholder="UTR / reference"]').fill('UTR-E2E-' + stamp);
  await inv.locator('.invoice-pay').click();
  await expect(page.locator('.invoice-row').first()).toContainText('PAID');
  await page.locator('[role=dialog] button[aria-label=Close]').click();

  // lost password: temporary password works, old one does not
  await row.getByText('Reset password', { exact: true }).click();
  const temp = (await page.locator('#revealedPassword').innerText()).trim();
  expect(temp).toHaveLength(12);
  expect((await request.post('/api/v1/auth/login', { data: { email, password: temp } })).status()).toBe(200);
  expect((await request.post('/api/v1/auth/login', { data: { email, password: 'Welcome#2026' } })).status()).toBe(401);
  await page.getByRole('button', { name: 'Done' }).click();

  // support sign-in: lands inside the tenant with a banner, and there is a way back
  await row.locator('.tenant-support').click();
  await expect(page.locator('#supportBanner')).toContainText(email);
  await page.click('#nav-settings');
  await expect(page.locator('#planCard')).toContainText(tenant);
  await page.click('#supportExit');
  await expect(page.locator('#page-platform')).toBeVisible();
  await expect(page.locator('#supportBanner')).toHaveCount(0);
  await expect(page.locator('#auditCard')).toContainText('support.sign_in_as');

  // an Admin cannot open the Super Admin pages
  await page.evaluate(() => localStorage.clear());
  await reactLogin(page, 'owner@liquor.com');
  await page.goto('/platform');
  await expect(page.locator('#page-platform')).toHaveCount(0);
});

test('B2B: buyer GSTIN on the POS gives an IGST bill for another state', async ({ page, request }) => {
  await reactLogin(page, 'cashier@liquor.com');
  await page.click('#nav-pos');
  await page.fill('#posSearch', 'Paneer Tikka');
  await page.locator('.pos-product', { hasText: 'Paneer Tikka' }).click();
  await page.fill('#posBuyerGstin', '27AAAAA0000A1Z5');
  await page.click('#checkoutBtn');
  await expect(page.locator('#checkoutBillNo')).toBeVisible();
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, cashier, '/me');
  const text = await findReceipt(request, cashier, me.branchId, 'Buyer GSTIN: 27AAAAA0000A1Z5');
  expect(text).toContain('IGST');
  expect(text).toContain('HSN 9963');
});

test('Staff: a manager resets a cashier password; a user changes their own password', async ({ page, request }) => {
  const id = uniq();
  const mgr = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  const email = `pw.${id.toLowerCase()}@liquor.com`;
  await apiPost(request, mgr, '/users', { name: `Pw ${id}`, email, password: 'Password@123', role: 'cashier', branchId: me.branchId });

  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-admin');
  await page.locator('tr[data-email="' + email + '"] .user-reset').click();
  const temp = (await page.locator('#revealedPassword').innerText()).trim();
  expect((await request.post('/api/v1/auth/login', { data: { email, password: temp } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Done' }).click();

  await page.evaluate(() => localStorage.clear());
  await reactLogin(page, email, temp);
  await page.click('#changePasswordBtn');
  await page.fill('#pwCurrent', temp);
  await page.fill('#pwNew', 'Fresh#Pass99');
  await page.click('#pwSave');
  await expect(page.locator('#toastHost')).toContainText('Password changed');
  expect((await request.post('/api/v1/auth/login', { data: { email, password: 'Fresh#Pass99' } })).status()).toBe(200);
  expect((await request.post('/api/v1/auth/login', { data: { email, password: temp } })).status()).toBe(401);
});

test('Print queue: a bill sent while the printer is off is parked and printed on retry', async ({ page, request }) => {
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const mgr = await apiToken(request, 'manager@liquor.com');
  const owner = await apiToken(request, 'owner@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  const products = await apiGet<{ id: string; name: string }[]>(request, cashier, '/products');
  const bill = await apiPost<{ id: string }>(request, cashier, '/bills', {
    branchId: me.branchId, paymentMode: 'CASH', items: [{ productId: products.find((p) => p.name === 'Paneer Tikka')!.id, quantity: 1 }],
  });

  // find a free port, leave it unlistened so the printer is "off"
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const patch = await request.patch(`/api/v1/branches/${me.branchId}`, { headers: { Authorization: `Bearer ${owner}` }, data: { printerHost: '127.0.0.1', printerPort: port } });
  expect(patch.ok()).toBeTruthy();
  const queued = await request.post(`/api/v1/print/bills/${bill.id}/send?queue=true`, { headers: { Authorization: `Bearer ${cashier}` } });
  expect(queued.status()).toBe(202);

  await reactLogin(page, 'owner@liquor.com');
  await page.click('#nav-settings');
  await expect(page.locator('#printQueueCard')).toContainText('Retrying');

  const received: Buffer[] = [];
  const server = net.createServer((s) => s.on('data', (d) => received.push(d)));
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  try {
    await page.locator('.print-retry').first().click();
    await expect(page.locator('#toastHost')).toContainText('Printed');
    await expect.poll(() => Buffer.concat(received).toString('latin1')).toContain('TAX INVOICE');
  } finally {
    server.close();
    await request.patch(`/api/v1/branches/${me.branchId}`, { headers: { Authorization: `Bearer ${owner}` }, data: { printerHost: null } });
  }
});

test('Billing: the Admin renews and pays online (test gateway), the invoice shows PAID', async ({ page }) => {
  await reactLogin(page, 'owner@liquor.com');
  await page.click('#nav-settings');
  // the seeded demo business is on a paid plan with no invoice due: renew early to raise one
  await page.click('#renewBtn');
  await expect(page.locator('#dueInvoice')).toContainText('2,999.00');
  await page.click('#payNowBtn');
  await expect(page.getByText('this is a test payment')).toBeVisible();
  await page.click('#simulatePayBtn');
  await expect(page.locator('#toastHost')).toContainText('Payment received');
  await expect(page.locator('#dueInvoice')).toHaveCount(0);
  await expect(page.locator('.my-invoice').first()).toContainText('PAID');
  await expect(page.locator('.my-invoice').first()).toContainText('mock:mock_pay_');
  await expect(page.locator('#billingBanner')).toHaveCount(0);
});

test('Locked business: after the trial ends the Admin sees only the payment screen, pays, and the app opens', async ({ page, request }) => {
  const id = stamp.toLowerCase();
  const email = `lock.${id}@tenant.test`;
  const root = await apiToken(request, 'superadmin@liquor.com');
  const created = await apiPost<{ tenant: { id: string } }>(request, root, '/platform/tenants', {
    name: `Lock ${stamp}`, plan: 'TRIAL', admin: { name: 'Lock Admin', email, password: 'Welcome#2026' },
  });
  const expire = await request.patch(`/api/v1/platform/tenants/${created.tenant.id}`, {
    headers: { Authorization: `Bearer ${root}` }, data: { trialEndsAt: new Date(Date.now() - 86_400_000).toISOString() },
  });
  expect(expire.ok()).toBeTruthy();

  // sign in by hand: there is no #mainApp for a locked business, only the payment screen
  await page.goto('/login');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', 'Welcome#2026');
  await page.click('#loginBtn');
  await expect(page.locator('#subscriptionLocked')).toContainText('free trial has ended');
  await expect(page.locator('#nav-pos')).toHaveCount(0);

  await page.locator('.plan-choose', { hasText: 'Choose Standard' }).click();
  await expect(page.locator('#dueInvoice')).toContainText('2,999.00');
  await page.click('#payNowBtn');
  await page.click('#simulatePayBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });    // page reloads into the real app
  await expect(page.locator('#subscriptionLocked')).toHaveCount(0);
});

test('Forgot password: request a link, open it, choose a new password, sign in', async ({ page, request }) => {
  const id = uniq();
  const mgr = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  const email = `forgot.${id.toLowerCase()}@liquor.com`;
  await apiPost(request, mgr, '/users', { name: `Forgot ${id}`, email, password: 'Password@123', role: 'cashier', branchId: me.branchId });

  await page.goto('/login');
  await page.click('#forgotLink');
  await page.fill('#forgotEmail', email);
  await page.click('#forgotSubmit');
  await expect(page.locator('#forgotSent')).toContainText('reset link is on its way');

  // no mail server in the test setup: the message is in the outbox the Super Admin can read
  const root = await apiToken(request, 'superadmin@liquor.com');
  const { emails } = await apiGet<{ emails: { toEmail: string; body: string }[] }>(request, root, '/platform/outbox');
  const mail = emails.find((m) => m.toEmail === email)!;
  const token = /token=([0-9a-f]+)/.exec(mail.body)![1];

  await page.goto(`/reset-password?token=${token}`);
  await page.fill('#resetNew', 'Brand#New2026');
  await page.fill('#resetConfirm', 'Different#1');
  await page.click('#resetSubmit');
  await expect(page.locator('#resetError')).toContainText('do not match');
  await page.fill('#resetConfirm', 'Brand#New2026');
  await page.click('#resetSubmit');
  await expect(page.locator('#resetDone')).toBeVisible();
  expect((await request.post('/api/v1/auth/login', { data: { email, password: 'Brand#New2026' } })).status()).toBe(200);

  // the link works once
  await page.goto(`/reset-password?token=${token}`);
  await page.fill('#resetNew', 'Another#Pass1');
  await page.fill('#resetConfirm', 'Another#Pass1');
  await page.click('#resetSubmit');
  await expect(page.locator('#resetError')).toContainText('invalid or has expired');
});

test('Print agent: create the token in settings, a bill goes to the agent, the agent prints it and shows online', async ({ page, request }) => {
  const { loadConfig, runOnce } = await import('../../print-agent/agent-core.mjs');
  const out = path.join(os.tmpdir(), `e2e-agent-${stamp}.bin`);
  const owner = await apiToken(request, 'owner@liquor.com');
  const cashier = await apiToken(request, 'cashier@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, cashier, '/me');
  try {
    await reactLogin(page, 'owner@liquor.com');
    await page.click('#nav-settings');
    await page.locator('.branch-row', { hasText: 'MAIN-01' }).getByText('Edit', { exact: true }).click();
    await page.click('#agentTokenBtn');
    const token = (await page.locator('#agentTokenValue').innerText()).trim();
    expect(token).toMatch(/^pa_[0-9a-f]{48}$/);
    await page.check('#printViaAgent');
    await page.click('#branchSaveBtn');
    await expect(page.locator('.branch-row', { hasText: 'MAIN-01' })).toBeVisible();

    // a bill is rung and sent: it becomes an agent job instead of a TCP print
    const products = await apiGet<{ id: string; name: string }[]>(request, cashier, '/products');
    const bill = await apiPost<{ id: string }>(request, cashier, '/bills', {
      branchId: me.branchId, paymentMode: 'CASH', items: [{ productId: products.find((x) => x.name === 'Paneer Tikka')!.id, quantity: 1 }],
    });
    const sent = await request.post(`/api/v1/print/bills/${bill.id}/send?queue=true`, { headers: { Authorization: `Bearer ${cashier}` } });
    expect(sent.status()).toBe(202);
    expect((await sent.json()).agent).toBe(true);

    // the real agent code, pointed at this server, writing to a file "printer"
    const cfgFile = path.join(os.tmpdir(), `e2e-agent-cfg-${stamp}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({ serverUrl: 'http://localhost:3001', token, printer: { type: 'file', path: out } }));
    const result = await runOnce(loadConfig(cfgFile), () => undefined);
    fs.rmSync(cfgFile, { force: true });
    expect(result.failed).toBe(0);
    expect(result.printed).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(out).toString('latin1')).toContain('TAX INVOICE');

    // the settings screen now shows the agent as online
    await page.reload();
    await page.locator('.branch-row', { hasText: 'MAIN-01' }).getByText('Edit', { exact: true }).click();
    await expect(page.locator('#agentSection')).toContainText('Agent online');
  } finally {
    fs.rmSync(out, { force: true });
    await request.delete(`/api/v1/branches/${me.branchId}/agent-token`, { headers: { Authorization: `Bearer ${owner}` } });
  }
});

test('Super Admin: Integrations shows test mode and what is still missing', async ({ page }) => {
  await reactLogin(page, 'superadmin@liquor.com');
  const pay = page.locator('.integration-row[data-integration="payments"]');
  await expect(pay).toContainText('Test mode');
  await expect(pay).toContainText('RAZORPAY_KEY_ID');
  await expect(page.locator('.integration-row[data-integration="mail"]')).toContainText('SMTP_HOST');
  await page.click('#runBillingBtn');
  await expect(page.locator('#toastHost')).toContainText('Billing job done');
});
