/**
 * A business gives its staff the roles the Super Admin defined: a manager creates a person on a custom role, the person gets
 * exactly that area and nothing else, and the manager can change the role afterwards.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();
const roleName = `Ledger Viewer ${stamp}`;
const email = `viewer.${stamp.toLowerCase()}@biz.test`;

async function signIn(page: Page, who: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#loginEmail', who);
  await page.fill('#loginPass', password);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

test('A manager creates a person on a custom role; they get that area only; the manager changes the role', async ({ page, browser, request }) => {
  test.setTimeout(150_000);

  // The Super Admin defines the role (done through the API: the editor itself is covered by platform-roles.spec.ts)
  const login = await request.post('/api/v1/auth/login', { data: { email: 'superadmin@liquor.com', password: PASSWORD } });
  const token = (await login.json()).token as string;
  const made = await request.post('/api/v1/platform/roles', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: roleName, level: 'cashier', permissions: ['accounting.view'], pages: null },
  });
  expect(made.status()).toBe(201);

  // The manager creates a cashier on it
  await signIn(page, 'manager@liquor.com');
  await page.click('#nav-admin');
  await expect(page.locator('#nuName')).toBeVisible();
  await page.fill('#nuName', 'Ledger Viewer');
  await page.fill('#nuEmail', email);
  await page.fill('#nuPass', 'Welcome#2026');
  await page.selectOption('#nuRole', 'cashier');
  await page.selectOption('#nuCustomRole', { label: roleName });
  await page.click('#nuSubmit');
  const row = page.locator(`[data-email="${email}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-cell="role"]')).toContainText(roleName);

  // The person sees Accounting (the one area their role grants) and nothing else of the manager's
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await signIn(viewer, email, 'Welcome#2026');
  await expect(viewer.locator('#nav-accounting')).toBeVisible();
  await expect(viewer.locator('#nav-bank')).toHaveCount(0);
  await expect(viewer.locator('#nav-closing')).toHaveCount(0);
  await viewer.click('#nav-accounting');
  await expect(viewer.locator('#page-accounting')).toBeVisible();
  await viewer.goto('/bank');
  await expect(viewer).not.toHaveURL(/\/bank$/);                                                  // the page is closed to them
  const status = await viewer.evaluate(async () => {
    const t = localStorage.getItem('token');
    const b = await (await fetch('/api/v1/branches', { headers: { Authorization: `Bearer ${t}` } })).json();
    const r = await fetch(`/api/v1/bank/accounts?branchId=${b[0].id}`, { headers: { Authorization: `Bearer ${t}` } });
    return { status: r.status, body: await r.json() };
  });
  expect(status.status).toBe(403);
  expect(status.body).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'bank.reconcile' });

  // The manager opens the person's Access, sees the role, and puts them back on the built-in cashier
  await row.getByRole('button', { name: 'Access' }).click();
  await expect(page.locator('#currentRole')).toContainText(roleName);
  await expect(page.locator('#permissionSection')).toContainText('See accounting and reports');
  await page.selectOption('#roleChoice', { label: 'Cashier (built-in)' });
  await page.click('#roleChange');
  await expect(page.locator('#currentRole')).toHaveText('cashier');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(row.locator('[data-cell="role"]')).toHaveText('cashier');

  await viewer.reload();
  await expect(viewer.locator('#mainApp')).toBeVisible();
  await expect(viewer.locator('#nav-accounting')).toHaveCount(0);                                 // the grant went with the role
  await ctx.close();
});
