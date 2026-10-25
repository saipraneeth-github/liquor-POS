import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'Password@123';

/** Unique suffix so specs never collide on shared data within one run. */
export function uniq(): string {
  return Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
}

/** Logs in through the real login form and waits for the app shell. */
export async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  page.on('pageerror', (err) => console.error(`Uncaught page exception: "${err.message}"`));
  await page.goto('/');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', password);
  await page.click('button:has-text("Sign In")');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

/** API token for setup steps that are not under test. */
export async function apiToken(request: APIRequestContext, email: string, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).token as string;
}

export async function apiGet<T = unknown>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const res = await request.get('/api/v1' + path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

export async function apiPost<T = unknown>(request: APIRequestContext, token: string, path: string, data: unknown): Promise<T> {
  const res = await request.post('/api/v1' + path, { headers: { Authorization: `Bearer ${token}` }, data });
  expect(res.ok(), `${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** Adds the named product (search) to the POS cart. */
export async function addProduct(page: Page, search: string): Promise<void> {
  await page.click('#nav-pos');
  await page.fill('#posSearch', search);
  await page.locator('.pos-product', { hasText: search }).first().click();
  await expect(page.locator('#cartItems')).toContainText(search);
}

/** Checks out the current cart and returns the server bill number from the confirmation. */
export async function checkoutAndGetBillNo(page: Page): Promise<string> {
  await page.click('#checkoutBtn');
  await expect(page.locator('#checkoutModal')).toBeVisible({ timeout: 10000 });
  const billNo = (await page.locator('#checkoutBillNo').innerText()).trim();
  expect(billNo).not.toBe('');
  await page.click('#newBillBtn');
  await expect(page.locator('#checkoutModal')).toBeHidden();
  return billNo;
}
