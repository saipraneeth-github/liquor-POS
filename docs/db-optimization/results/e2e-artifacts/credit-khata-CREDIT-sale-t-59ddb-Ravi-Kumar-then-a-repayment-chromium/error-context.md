# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: credit-khata.spec.ts >> CREDIT sale to khata customer Ravi Kumar, then a repayment
- Location: tests\e2e\credit-khata.spec.ts:19:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 18000
Received: 16000
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]:
        - generic [ref=e11]:
          - generic [ref=e12]: Liquor Counter
          - generic [ref=e13]: MAIN-01 — Main Counter Branch
        - button "Close navigation sidebar" [ref=e14] [cursor=pointer]
      - navigation [ref=e18]:
        - generic [ref=e19]:
          - generic [ref=e20]: Overview
          - link "Dashboard" [ref=e21] [cursor=pointer]:
            - /url: /
        - generic [ref=e27]:
          - generic [ref=e28]: Sell
          - link "Billing (POS)" [ref=e29] [cursor=pointer]:
            - /url: /pos
          - link "Cashier Shift" [ref=e35] [cursor=pointer]:
            - /url: /shift
          - link "Bills" [ref=e39] [cursor=pointer]:
            - /url: /bills
          - link "Tables & Orders (KOT)" [ref=e43] [cursor=pointer]:
            - /url: /tables
          - link "Customers & Khata" [ref=e46] [cursor=pointer]:
            - /url: /customers
        - generic [ref=e52]:
          - generic [ref=e53]: Menu & Stock
          - link "Kitchen Menu" [ref=e54] [cursor=pointer]:
            - /url: /menu/kitchen
          - link "Bar Menu" [ref=e60] [cursor=pointer]:
            - /url: /menu/bar
          - link "Products" [ref=e64] [cursor=pointer]:
            - /url: /products
          - link "Supplier Invoices" [ref=e67] [cursor=pointer]:
            - /url: /invoices
          - link "Inventory" [ref=e72] [cursor=pointer]:
            - /url: /inventory
          - link "Counter Stock Sheet" [ref=e77] [cursor=pointer]:
            - /url: /counter
      - generic [ref=e81]:
        - generic [ref=e82]:
          - generic [ref=e83]: Counter Cashier (Cashier)
          - generic [ref=e84]: cashier@liquor.com
        - button "Change password" [ref=e85] [cursor=pointer]
        - button "Sign out" [ref=e86] [cursor=pointer]
  - generic [ref=e90]:
    - banner [ref=e91]:
      - generic [ref=e92]:
        - button "Close navigation menu" [ref=e93] [cursor=pointer]
        - generic [ref=e95]: Customers & Khata
      - button "Toggle dark/light theme" [ref=e97] [cursor=pointer]:
        - generic [ref=e104]: Light
    - main [ref=e105]:
      - region [ref=e106]:
        - heading "Customers & Khata" [level=2] [ref=e107]
        - generic [ref=e108]:
          - generic [ref=e109]:
            - generic [ref=e110]:
              - generic [ref=e111]:
                - generic [ref=e112]: Search customers
                - textbox "Search customers" [ref=e113]:
                  - /placeholder: Search by name or phone
                  - text: Ravi
                - button "Search" [ref=e114]
              - table [ref=e117]:
                - rowgroup [ref=e118]:
                  - row [ref=e119]:
                    - columnheader "Customer" [ref=e120]
                    - columnheader "Credit" [ref=e121]
                    - columnheader "Outstanding" [ref=e122]
                    - columnheader [ref=e123]
                - rowgroup [ref=e124]:
                  - row [ref=e125]:
                    - cell "Ravi Kumar 9876543210" [ref=e126]:
                      - text: Ravi Kumar
                      - generic [ref=e127]: "9876543210"
                    - cell "Limit ₹5000.00" [ref=e128]
                    - cell "₹160.00" [ref=e130]
                    - cell [ref=e131]:
                      - button "Statement" [active] [ref=e132]
            - group [ref=e133]:
              - generic "+ New customer" [ref=e134] [cursor=pointer]
          - generic [ref=e136]:
            - generic [ref=e137]:
              - generic [ref=e138]:
                - generic [ref=e139]: Ravi Kumar
                - generic [ref=e140]: "9876543210"
              - generic [ref=e141]: Credit allowed
            - generic [ref=e142]:
              - generic [ref=e143]:
                - generic [ref=e144]: Outstanding
                - generic [ref=e145]: ₹160.00
              - generic [ref=e146]:
                - generic [ref=e147]: Credit limit
                - generic [ref=e148]: ₹5000.00
              - generic [ref=e149]:
                - generic [ref=e150]: Remaining
                - generic [ref=e151]: ₹4840.00
            - generic [ref=e152]:
              - generic [ref=e153]:
                - generic [ref=e154]:
                  - text: Repayment (₹)
                  - textbox "Repayment (₹)" [ref=e155]
                - generic [ref=e156]:
                  - text: Mode
                  - combobox "Mode" [ref=e157]:
                    - option "CASH" [selected]
                    - option "UPI"
                    - option "CARD"
              - generic [ref=e158]:
                - text: Notes
                - textbox "Notes" [ref=e159]
              - button "Record repayment" [ref=e160] [cursor=pointer]
            - generic [ref=e161]: Khata ledger
            - table [ref=e163]:
              - rowgroup [ref=e164]:
                - row [ref=e165]:
                  - columnheader "Date" [ref=e166]
                  - columnheader "Type" [ref=e167]
                  - columnheader "Amount" [ref=e168]
                  - columnheader "Balance" [ref=e169]
                  - columnheader "Notes" [ref=e170]
              - rowgroup [ref=e171]:
                - row [ref=e172]:
                  - cell "13/11/2026, 8:53:01 pm" [ref=e173]
                  - cell "PURCHASE" [ref=e174]
                  - cell "₹160.00" [ref=e175]
                  - cell "₹160.00" [ref=e176]
                  - cell "Bill MAIN-01-2026-000002" [ref=e177]
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | import { addProduct, login } from './helpers';
  3  | 
  4  | function paise(text: string): number {
  5  |   const m = text.replace(/[₹,\s]/g, '').match(/^(-?)(\d+)\.(\d{2})/);
  6  |   if (!m) throw new Error('not money: ' + text);
  7  |   return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
  8  | }
  9  | 
  10 | async function openRaviStatement(page: Page) {
  11 |   await page.click('#nav-customers');
  12 |   await page.fill('#custSearch', 'Ravi');
  13 |   await page.click('#custSearchBtn');
  14 |   await page.locator('.cust-row', { hasText: 'Ravi Kumar' }).getByRole('button', { name: 'Statement' }).click();
  15 |   await expect(page.locator('#custStatementName')).toHaveText('Ravi Kumar');
  16 |   return paise(await page.locator('#custOutstanding').innerText());
  17 | }
  18 | 
  19 | test('CREDIT sale to khata customer Ravi Kumar, then a repayment', async ({ page }) => {
  20 |   await login(page, 'cashier@liquor.com');
  21 |   const before = await openRaviStatement(page);
  22 | 
  23 |   // Credit sale of one Kingfisher (₹180)
  24 |   await addProduct(page, 'Kingfisher');
  25 |   await page.click('#pay-CREDIT');
  26 |   await page.fill('#creditSearch', 'Ravi');
  27 |   await page.locator('#creditResults .list-btn', { hasText: 'Ravi Kumar' }).click();
  28 |   const card = page.locator('#creditCustomerCard');
  29 |   await expect(card).toContainText(/Limit\s*₹5,000\.00/);
  30 |   const remainingBefore = paise(await page.locator('#creditRemaining').innerText());
  31 |   expect(remainingBefore).toBe(500000 - before);
  32 | 
  33 |   await page.click('#checkoutBtn');
  34 |   await expect(page.locator('#checkoutModal')).toBeVisible();
  35 |   await expect(page.locator('#checkoutSummary')).toContainText('collected via CREDIT');
  36 |   await expect(page.locator('#checkoutSummary')).toContainText('Ravi Kumar');
  37 |   await page.click('#newBillBtn');
  38 | 
  39 |   // Khata now owes ₹180 more
  40 |   const afterSale = await openRaviStatement(page);
> 41 |   expect(afterSale - before).toBe(18000);
     |                              ^ Error: expect(received).toBe(expected) // Object.is equality
  42 |   await expect(page.locator('#custEntries')).toContainText('PURCHASE');
  43 | 
  44 |   // Repay ₹180 in cash → back to the original balance
  45 |   await page.fill('#repayAmount', '180');
  46 |   await page.locator('#repayMode').selectOption('CASH');
  47 |   await page.click('#repayBtn');
  48 |   await expect(page.locator('#custEntries')).toContainText('REPAYMENT');
  49 |   await expect.poll(async () => paise(await page.locator('#custOutstanding').innerText())).toBe(before);
  50 | });
  51 | 
```