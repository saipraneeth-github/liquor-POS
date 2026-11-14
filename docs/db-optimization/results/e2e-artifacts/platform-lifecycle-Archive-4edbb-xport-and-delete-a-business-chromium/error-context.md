# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: platform-lifecycle.spec.ts >> Archive, restore, export and delete a business
- Location: tests\e2e\platform-lifecycle.spec.ts:23:1

# Error details

```
Error: expect(locator).toBeEnabled() failed

Locator:  locator('#deleteOk')
Expected: enabled
Received: disabled
Timeout:  15000ms

Call log:
  - Expect "toBeEnabled" locator('#deleteOk') with timeout 15000ms
  - waiting for locator('#deleteOk')
    33 × locator resolved to <button disabled type="button" id="deleteOk" class="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg cursor-pointer">Delete permanently</button>
       - unexpected value "disabled"

```

```yaml
- button "Delete permanently" [disabled]
```

# Test source

```ts
  1   | /**
  2   |  * Super Admin: archive, restore, export and permanently delete a business.
  3   |  * Build the frontend first: `npm run build:frontend`. The e2e server runs with ARCHIVE_RETENTION_DAYS=0 so the
  4   |  * 30-day wait is skipped; the real wait is covered by tests/integration/platform-lifecycle.int.test.ts.
  5   |  */
  6   | import { test, expect, type Page } from '@playwright/test';
  7   | import { PASSWORD, uniq } from './helpers';
  8   | 
  9   | const stamp = uniq();
  10  | const tenantName = `Life Bar ${stamp}`;
  11  | const adminEmail = `life.${stamp.toLowerCase()}@tenant.test`;
  12  | 
  13  | async function loginSuper(page: Page) {
  14  |   await page.goto('/login');
  15  |   await page.fill('#loginEmail', 'superadmin@liquor.com');
  16  |   await page.fill('#loginPass', PASSWORD);
  17  |   await page.click('#loginBtn');
  18  |   await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  19  |   await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ', { timeout: 20000 });
  20  |   await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
  21  | }
  22  | 
  23  | test('Archive, restore, export and delete a business', async ({ page }) => {
  24  |   await loginSuper(page);
  25  |   await page.click('#tenantAddBtn');
  26  |   await page.fill('#tenantName', tenantName);
  27  |   await page.fill('#tenantAdminName', 'Life Admin');
  28  |   await page.fill('#tenantAdminEmail', adminEmail);
  29  |   await page.fill('#tenantAdminPassword', 'Welcome#2026');
  30  |   await page.click('#tenantSaveBtn');
  31  |   const row = page.locator('.tenant-row', { hasText: tenantName });
  32  |   await expect(row).toBeVisible();
  33  | 
  34  |   // Archive needs a reason, then the business leaves the active list
  35  |   await row.locator('.tenant-archive').click();
  36  |   await page.click('#archiveOk');
  37  |   await expect(page.locator('#archiveForm')).toContainText('Say why');
  38  |   await page.fill('#archiveReason', 'Stopped trading');
  39  |   await page.click('#archiveOk');
  40  |   await expect(row).toHaveCount(0);
  41  | 
  42  |   // It shows under "Archived", with the reason, and only the archive actions
  43  |   await page.selectOption('#tenantStatusFilter', 'ARCHIVED');
  44  |   await expect(row).toBeVisible();
  45  |   await expect(row).toContainText('Archived');
  46  |   await expect(row).toContainText('Stopped trading');
  47  |   await expect(row.locator('.tenant-restore')).toBeVisible();
  48  |   await expect(row.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
  49  | 
  50  |   // Restore brings it back
  51  |   await row.locator('.tenant-restore').click();
  52  |   await expect(row).toHaveCount(0);
  53  |   await page.selectOption('#tenantStatusFilter', 'ACTIVE');
  54  |   await expect(row).toBeVisible();
  55  |   await expect(row).not.toContainText('Archived');
  56  | 
  57  |   // Archive again, then delete: the button stays off until the name is typed and the warning ticked
  58  |   await row.locator('.tenant-archive').click();
  59  |   await page.fill('#archiveReason', 'Closing down for good');
  60  |   await page.click('#archiveOk');
  61  |   await page.selectOption('#tenantStatusFilter', 'ARCHIVED');
  62  |   await row.locator('.tenant-delete').click();
  63  |   await expect(page.locator('#deleteForm')).toContainText('This cannot be undone');
  64  |   await expect(page.locator('#exportBox')).toContainText('Download a copy before deleting');
  65  |   await expect(page.locator('#deleteOk')).toBeDisabled();
  66  |   await page.fill('#deleteConfirmName', 'Some other name');
  67  |   await page.check('#deleteAck');
  68  |   await expect(page.locator('#deleteOk')).toBeDisabled();                       // wrong name
  69  |   await page.fill('#deleteConfirmName', tenantName.toLowerCase());
  70  |   await expect(page.locator('#deleteOk')).toBeDisabled();                       // right name, wrong capitals
  71  |   await page.fill('#deleteConfirmName', tenantName);
  72  |   await page.uncheck('#deleteAck');
  73  |   await expect(page.locator('#deleteOk')).toBeDisabled();                       // not acknowledged
  74  | 
  75  |   // Download a copy first
  76  |   const downloading = page.waitForEvent('download');
  77  |   await page.click('#exportData');
  78  |   expect((await downloading).suggestedFilename()).toMatch(/Life-Bar-.*-export-\d{4}-\d{2}-\d{2}\.json$/);
  79  |   await expect(page.locator('#exportBox')).toContainText('Data downloaded');
  80  | 
  81  |   await page.check('#deleteAck');
> 82  |   await expect(page.locator('#deleteOk')).toBeEnabled();
      |                                           ^ Error: expect(locator).toBeEnabled() failed
  83  |   await page.click('#deleteOk');
  84  |   await expect(page.locator('#deleteForm')).toHaveCount(0);
  85  |   await expect(row).toHaveCount(0);
  86  |   await page.selectOption('#tenantStatusFilter', 'ALL');
  87  |   await expect(row).toHaveCount(0);                                              // gone from every view
  88  | 
  89  |   // The audit log remembers it
  90  |   await page.click('#nav-platform-audit');
  91  |   await page.selectOption('#auAction', 'tenant.delete');
  92  |   await expect(page.locator('[data-audit-row="tenant.delete"]').first()).toBeVisible();
  93  | });
  94  | 
  95  | test('Tenants: on a phone the table becomes cards with the actions folded away', async ({ page }) => {
  96  |   await loginSuper(page);
  97  |   await page.setViewportSize({ width: 390, height: 800 });
  98  |   await expect(page.locator('#tenantCards')).toBeVisible();
  99  |   await expect(page.locator('#tenantTable')).toBeHidden();
  100 |   const card = page.locator('.tenant-card').first();
  101 |   await expect(card).toBeVisible();
  102 |   await card.locator('summary').click();
  103 |   await expect(card.getByRole('button', { name: 'Change plan' })).toBeVisible();
  104 | });
  105 | 
```