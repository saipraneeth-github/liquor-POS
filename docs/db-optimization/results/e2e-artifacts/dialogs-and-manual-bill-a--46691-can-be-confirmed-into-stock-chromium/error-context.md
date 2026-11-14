# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dialogs-and-manual-bill.spec.ts >> a supplier bill typed in by hand can be confirmed into stock
- Location: tests\e2e\dialogs-and-manual-bill.spec.ts:60:1

# Error details

```
Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Add Supplier Bill' }) resolved to 2 elements:
    1) <button type="button" class="px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer text-gray-700 hover:text-gray-900 hover:bg-gray-100">Add Supplier Bill</button> aka getByRole('button', { name: 'Add Supplier Bill', exact: true })
    2) <button type="button" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow-sm flex items-center gap-2 cursor-pointer self-start sm:self-auto">…</button> aka getByRole('button', { name: '＋ Add Supplier Bill' })

Call log:
  - waiting for getByRole('button', { name: 'Add Supplier Bill' })

```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - complementary [ref=f1e4]:
    - generic [ref=f1e5]:
      - generic [ref=f1e6]:
        - generic [ref=f1e11]:
          - generic [ref=f1e12]: Liquor Counter
          - generic [ref=f1e13]: MAIN-01 — Main Counter Branch
        - button "Close navigation sidebar" [ref=f1e14] [cursor=pointer]
      - navigation [ref=f1e18]:
        - generic [ref=f1e19]:
          - generic [ref=f1e20]: Overview
          - link "Dashboard" [ref=f1e21] [cursor=pointer]:
            - /url: /
        - generic [ref=f1e27]:
          - generic [ref=f1e28]: Sell
          - link "Billing (POS)" [ref=f1e29] [cursor=pointer]:
            - /url: /pos
          - link "Cashier Shift" [ref=f1e35] [cursor=pointer]:
            - /url: /shift
          - link "Bills" [ref=f1e39] [cursor=pointer]:
            - /url: /bills
          - link "Tables & Orders (KOT)" [ref=f1e43] [cursor=pointer]:
            - /url: /tables
          - link "Customers & Khata" [ref=f1e46] [cursor=pointer]:
            - /url: /customers
        - generic [ref=f1e52]:
          - generic [ref=f1e53]: Menu & Stock
          - link "Kitchen Menu" [ref=f1e54] [cursor=pointer]:
            - /url: /menu/kitchen
          - link "Bar Menu" [ref=f1e60] [cursor=pointer]:
            - /url: /menu/bar
          - link "Products" [ref=f1e64] [cursor=pointer]:
            - /url: /products
          - link "Supplier Invoices" [ref=f1e67] [cursor=pointer]:
            - /url: /invoices
          - link "Inventory" [ref=f1e72] [cursor=pointer]:
            - /url: /inventory
          - link "Counter Stock Sheet" [ref=f1e77] [cursor=pointer]:
            - /url: /counter
          - link "Peg Control" [ref=f1e81] [cursor=pointer]:
            - /url: /pour
        - generic [ref=f1e85]:
          - generic [ref=f1e86]: Money & Compliance
          - link "Supplier Schemes" [ref=f1e87] [cursor=pointer]:
            - /url: /schemes
          - link "Excise & Breakage" [ref=f1e92] [cursor=pointer]:
            - /url: /compliance
          - link "Accounting" [ref=f1e96] [cursor=pointer]:
            - /url: /accounting
          - link "Match Bank Statement" [ref=f1e99] [cursor=pointer]:
            - /url: /bank
          - link "Day Closing" [ref=f1e102] [cursor=pointer]:
            - /url: /closing
        - generic [ref=f1e106]:
          - generic [ref=f1e107]: Business
          - link "Staff & Billing Counters" [ref=f1e108] [cursor=pointer]:
            - /url: /admin
      - generic [ref=f1e112]:
        - generic [ref=f1e113]:
          - generic [ref=f1e114]: Branch Manager (Manager)
          - generic [ref=f1e115]: manager@liquor.com
        - button "Change password" [ref=f1e116] [cursor=pointer]
        - button "Sign out" [ref=f1e117] [cursor=pointer]
  - generic [ref=f1e121]:
    - banner [ref=f1e122]:
      - generic [ref=f1e123]:
        - button "Close navigation menu" [ref=f1e124] [cursor=pointer]
        - generic [ref=f1e126]: Supplier Invoices
      - button "Toggle dark/light theme" [ref=f1e128] [cursor=pointer]:
        - generic [ref=f1e135]: Light
    - main [ref=f1e136]:
      - region [ref=f1e137]:
        - generic [ref=f1e138]:
          - generic [ref=f1e139]:
            - heading "Supplier Invoices" [level=1] [ref=f1e140]
            - paragraph [ref=f1e141]: All uploaded supplier invoices with immutable snapshots and history.
          - generic [ref=f1e142]:
            - button "Add Supplier Bill" [ref=f1e143] [cursor=pointer]
            - button "Supplier Invoices 0" [ref=f1e144] [cursor=pointer]:
              - text: Supplier Invoices
              - generic [ref=f1e145]: "0"
        - generic [ref=f1e146]:
          - generic [ref=f1e147]:
            - generic [ref=f1e148]:
              - heading "All Uploaded Invoices" [level=2] [ref=f1e149]
              - paragraph [ref=f1e150]: Open a bill to see it as it was saved. To add bills, use the Add Supplier Bill button.
            - button "＋ Add Supplier Bill" [ref=f1e151] [cursor=pointer]:
              - generic [ref=f1e152]: ＋
              - text: Add Supplier Bill
          - generic [ref=f1e153]:
            - textbox "Search invoice no., supplier, amount or date" [ref=f1e155]
            - combobox [ref=f1e156]:
              - option "All statuses" [selected]
              - option "Added to Stock"
              - option "Reviewed"
              - option "Draft"
              - option "Cancelled"
              - option "Reversed"
            - button "View" [ref=f1e157] [cursor=pointer]
          - status [ref=f1e162]:
            - img "Loading animation" [ref=f1e164]
            - generic [ref=f1e165]: Loading Invoices…
            - generic [ref=f1e166]: Fetching all uploaded supplier invoices…
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | import { PASSWORD, uniq } from './helpers';
  3  | 
  4  | const stamp = uniq();
  5  | 
  6  | async function login(page: Page, email: string): Promise<void> {
  7  |   await page.goto('/login');
  8  |   await page.fill('#loginEmail', email);
  9  |   await page.fill('#loginPass', PASSWORD);
  10 |   await page.click('#loginBtn');
  11 |   await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
  12 | }
  13 | 
  14 | /** Where the open dialog's card sits against the middle of the window, in pixels (0 = centred). */
  15 | async function centreOffset(page: Page): Promise<number> {
  16 |   return page.evaluate(() => {
  17 |     const overlay = [...document.querySelectorAll('[role=dialog]')].pop() as HTMLElement | undefined;
  18 |     if (!overlay) return 9999;
  19 |     const c = (overlay.firstElementChild as HTMLElement).getBoundingClientRect();
  20 |     return Math.round((c.top + c.bottom) / 2 - window.innerHeight / 2);
  21 |   });
  22 | }
  23 | 
  24 | test('dialogs open in the middle of the window, on a tall screen and on a short one', async ({ page }) => {
  25 |   await page.setViewportSize({ width: 1600, height: 1000 });
  26 |   await login(page, 'manager@liquor.com');
  27 |   await page.click('#changePasswordBtn');
  28 |   await expect(page.locator('[role=dialog]')).toBeVisible();
  29 |   expect(Math.abs(await centreOffset(page))).toBeLessThanOrEqual(2);
  30 |   await page.keyboard.press('Escape');
  31 |   await page.locator('[role=dialog] button[aria-label="Close"]').click();
  32 | 
  33 |   // a short window: the dialog must still be reachable from its first field to its last button
  34 |   await page.setViewportSize({ width: 1100, height: 420 });
  35 |   await page.click('#changePasswordBtn');
  36 |   await expect(page.locator('[role=dialog]')).toBeVisible();
  37 |   const reach = await page.evaluate(async () => {
  38 |     const overlay = document.querySelector('[role=dialog]') as HTMLElement;
  39 |     overlay.scrollTop = overlay.scrollHeight;
  40 |     await new Promise((r) => setTimeout(r, 150));
  41 |     const save = document.querySelector('#pwSave')!.getBoundingClientRect();
  42 |     overlay.scrollTop = 0;
  43 |     await new Promise((r) => setTimeout(r, 150));
  44 |     const first = document.querySelector('#pwCurrent')!.getBoundingClientRect();
  45 |     return { saveInView: save.bottom <= window.innerHeight + 1, firstInView: first.top >= 0 };
  46 |   });
  47 |   expect(reach).toEqual({ saveInView: true, firstInView: true });
  48 | });
  49 | 
  50 | test('forgot password: the form sits a little above the middle, not pushed down', async ({ page }) => {
  51 |   await page.setViewportSize({ width: 1366, height: 768 });
  52 |   await page.goto('/forgot-password');
  53 |   const box = await page.locator('.lc-login-form').first().boundingBox();
  54 |   expect(box).not.toBeNull();
  55 |   const centre = box!.y + box!.height / 2;
  56 |   expect(centre).toBeLessThan(768 / 2);
  57 |   expect(centre).toBeGreaterThan(768 * 0.3);
  58 | });
  59 | 
  60 | test('a supplier bill typed in by hand can be confirmed into stock', async ({ page }) => {
  61 |   // The brand code is the first word of the description and brand mappings are shared by the whole business,
  62 |   // so it must be unique to this run or the stock would land on an earlier run's product.
  63 |   const product = `MB${stamp} Manual Brandy 750ml`;
  64 |   const invNo = `MAN-${stamp}`;
  65 |   await login(page, 'manager@liquor.com');
  66 | 
  67 |   await page.goto('/invoices');
> 68 |   await page.getByRole('button', { name: 'Add Supplier Bill' }).click();
     |                                                                 ^ Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Add Supplier Bill' }) resolved to 2 elements:
  69 |   await page.getByText('Enter bill items manually').click();
  70 |   await page.locator('#invEditSupplier').fill(`Depot ${stamp}`);
  71 |   await page.locator('#invEditNumber').fill(invNo);
  72 | 
  73 |   // The first line starts as a placeholder: describe it and set 6 bottles at 400.00 (MRP 600.00)
  74 |   const row = page.locator('#invEditLines .inv-edit-row').first();
  75 |   await row.getByTitle('Edit row fields').click();
  76 |   await row.locator('.ie-desc').fill(product);
  77 |   await row.locator('.ie-qty').fill('6');
  78 |   await row.locator('.ie-cost').fill('400.00');
  79 |   await row.locator('.ie-mrp').fill('600.00');
  80 |   await row.getByTitle('Save and make read-only').click();
  81 | 
  82 |   // A new brand has to be added to the catalogue before stock can be inwarded against it
  83 |   await row.getByRole('button', { name: 'Save to Mapping' }).click();
  84 |   await expect(row).toHaveAttribute('data-match-status', /^(MATCHED|MANUAL)$/, { timeout: 15000 });
  85 | 
  86 |   await page.click('#invReviewBtn');
  87 |   await page.getByRole('button', { name: /Submit Invoice/ }).click();
  88 | 
  89 |   // the dialog states what will be posted, worked out from the lines (6 bottles at the line's cost)
  90 |   await page.click('#invApproveBtn');
  91 |   await expect(page.locator('#confirmOk')).toBeVisible();
  92 |   await expect(page.locator('[role=dialog], #modal').last()).toContainText('₹2400.00');
  93 |   await page.click('#confirmOk');
  94 | 
  95 |   await expect(page.locator('#invHistoryBox tr', { hasText: invNo })).toContainText('Added to Stock', { timeout: 20000 });
  96 |   await page.goto('/inventory');
  97 |   await expect(page.locator('#stockTable tbody tr', { hasText: product })).toContainText('6', { timeout: 15000 });
  98 | });
  99 | 
```