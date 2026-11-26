# Liquor Counter POS browser QA

Tested on 26 November 2026 against commit `226a39e` using Microsoft Playwright MCP and headless Chrome. The app ran at `http://localhost:3311` with a fresh in-memory PGlite database, seeded demo users and stock, and mock payments.

## Confirmed defects

| ID | Severity | Finding |
|---|---|---|
| QA-01 | P1 | Record Breakage crashes Inventory |
| QA-02 | P1 | Bank import verifies a statement with a mismatched dated opening balance |
| QA-03 | P1 | Resuming a parked POS bill drops a rupee discount |
| QA-04 | P1 | Resuming a parked bill in another outlet can discard it from its original outlet |
| QA-05 | P2 | Cashiers can start a supplier invoice upload that the API always rejects for their permission set |
| QA-06 | P2 | Accounting tabs push the entire page sideways on phones and tablets |
| QA-07 | P2 | The Counter Stock Sheet action row pushes Post sheet off-screen on phones |
| QA-08 | P2 | The Products toolbar pushes the price-by-sale-type action off-screen on phones |
| QA-09 | P2 | The closed mobile navigation drawer receives keyboard focus |
| QA-10 | P2 | The closed mobile POS cart receives keyboard focus |
| QA-11 | P2 | Shared dialogs lack a programmatic title and let keyboard focus leave the dialog |
| QA-12 | P2 | The stock-reset confirmation and result misstate which records are deleted |
| QA-13 | P3 | The empty invoice list points to a button under an obsolete label |

P1 covers blocked operational work and incorrect money or order state. P2 covers recoverable workflow and accessibility defects. P3 covers misleading copy.

### QA-01 · Record Breakage crashes Inventory

Sign in as Manager, open **Inventory**, wait for the stock list, and click **Record Breakage**. The page displays “Something went wrong” and `ie.map is not a function`. This happened twice and both occurrences appeared in Super Admin → Errors.

The breakage request returned HTTP 200 with `{ entries, totals }`. Inventory passes the entire object to its history state and calls `.map()` on it. The form and history should open with an empty list when there are no breakages. [Screenshot](../../test-results/qa-audit/inventory-breakage-crash.png) · [Inventory state and history](../../frontend/src/inventory/Inventory.tsx#L120)

### QA-02 · Dated opening-balance row can produce a false “Statement verified”

As Manager, create a demo bank account, open **Match Bank Statement → Upload statement**, and preview this CSV.

```csv
Date,Narration,Debit,Credit,Balance
26/11/2026,OPENING BALANCE,,,1000.00
26/11/2026,QA BANK FEE,100.00,,925.00
27/11/2026,QA CREDIT,,250.00,1175.00
```

The screen warns that it skipped a row, replaces the stated ₹1,000.00 opening balance with an inferred ₹1,025.00, shows “Statement verified,” and enables import. The same file with the date removed from the opening-balance row keeps ₹1,000.00, detects the ₹25.00 difference, and disables import. A dated row explicitly labeled as the opening balance should also participate in validation. The test stopped at the preview. [Screenshot](../../test-results/qa-audit/bank-dated-opening-verification.png) · [Opening-balance detection](../../src/modules/bank/bank.engine.ts#L322)

### QA-03 · Parked bills lose rupee discounts

As Cashier, add one **Old Monk XXX Rum 750 ml** at ₹450.00, switch the discount control to rupees, enter ₹10.00, and click **Park**. Open **Parked** and **Resume** the bill. The parked list shows ₹440.00. The resumed cart switches to a blank percentage discount and shows ₹450.00. Resuming should retain the discount mode, amount, and payable total when the item price and quantity are unchanged. [Browser result](../../test-results/qa-audit/followup-pos.json) · [Park and resume logic](../../frontend/src/pos/POS.tsx#L501)

### QA-04 · A parked bill can be lost from its original outlet

As Business Owner, create or select a second outlet with no stock of Old Monk. At the Main Counter outlet, add a bottle and **Park** the ₹450.00 bill. Switch to the second outlet, open **Parked**, and click **Resume**. The original bill appears in the second outlet, resume produces an empty cart with a stock warning, and returning to the Main Counter outlet shows no parked bills.

A parked bill should stay available in its original outlet. Trying to resume it from another outlet should preserve the original draft. The storage key is tied to the user and the resume path removes the entry even when all lines are skipped. [Browser result](../../test-results/qa-audit/followup-branch.json) · [Parked-bill storage](../../frontend/src/pos/posLogic.ts#L78) · [Resume logic](../../frontend/src/pos/POS.tsx#L530)

### QA-05 · Supplier Invoices leads a cashier into an unusable upload

As the seeded Cashier, open **Supplier Invoices** from the sidebar, click **Add Supplier Bill**, select a valid CSV, and click **Upload & Read Bill**. The workflow exposes the upload form and then receives HTTP 403 with “you do not have permission to see cost prices and supplier invoices.” The history tab is missing in this state. The page should communicate the access restriction before asking the cashier to pick and submit a file. A Manager uploaded a valid demo CSV successfully. [Browser result](../../test-results/qa-audit/followup-pos.json) · [Ungated upload entry point](../../frontend/src/invoices/InvoiceUpload.tsx#L1232)

### QA-06 · Accounting tabs overflow the page at phone and tablet widths

As Manager or Owner, open **Accounting** at 375 × 812. The content pane is 375 px wide and scrolls horizontally to 810 px. Cash Book, Expenses, Suppliers, Margin, and Tally Export lie beyond the initial viewport. At 768 px, the sidebar leaves 512 px for content and the page still requires 810 px. Tab navigation should stay within the content width or use a dedicated, discoverable scroll area. [Phone screenshot](../../test-results/qa-audit/accounting-tabs-375.png) · [Accounting tab strip](../../frontend/src/accounting/Ledger.tsx#L138)

### QA-07 · Counter Stock Sheet pushes Post sheet off-screen on phones

As Owner, open **Counter Stock Sheet** at 375 × 812 with a draft sheet. In the recorded run, billing had already created the draft. The content pane expands to 454 px, and the **Post sheet** button extends 79 px past the right edge. Draft actions should fit the phone viewport so staff can discover and reach them without panning the page. [Screenshot](../../test-results/qa-audit/counter-actions-375.png) · [Counter post action](../../frontend/src/counter/Counter.tsx#L1108)

### QA-08 · Products pricing action extends past the edge of a phone

As Owner, open **Products** at 375 × 812. The content pane expands to 435 px, and the right side of **Prices by Sale Type (Janata / Walk-in)** extends 60 px beyond the viewport. The page toolbar should wrap or reflow at phone widths. [Screenshot](../../test-results/qa-audit/product-actions-375.png) · [Pricing controls](../../frontend/src/products/Products.tsx#L280)

### QA-09 · Closed mobile sidebar takes invisible keyboard focus

As Owner at 375 × 812, load the Dashboard with navigation closed. Press **Tab** twice. Focus goes to **Close navigation sidebar** and then **Dashboard** inside the off-screen drawer. Both elements ended 17 px to the left of the viewport. The header button announces “Close navigation menu” with the drawer both open and closed. Closed navigation should be outside the tab order and the toggle should announce its current action. [Browser result](../../test-results/qa-audit/followup-mobile.json) · [Drawer and toggle](../../frontend/src/components/Layout.tsx#L294)

### QA-10 · Closed mobile POS cart takes invisible keyboard focus

At 375 × 812, sign in as Cashier and add a product. With the cart sheet closed, focus the bottom **View** cart bar and press **Shift+Tab**. Focus enters the off-screen **Checkout & Print** button, GSTIN field, tender field, and payment buttons. The checkout button started at y=1,423.5 in an 812 px viewport. Opening the cart by touch worked, including the ₹10 discount control. Closed cart controls should be outside the tab order until the sheet is open. [Browser result](../../test-results/qa-audit/followup-touch.json) · [POS cart sheet](../../frontend/src/pos/POS.tsx#L960)

### QA-11 · Shared dialogs lack a title for assistive technology and lose keyboard focus

As Manager, open **Match Bank Statement → Add account** and navigate with **Tab** and **Escape**. Focus remains on the background trigger on open, the first Tab reaches another background button, later Tabs reach the sidebar, and Escape leaves the dialog open. **Business Settings → Add branch** also stayed open after Escape.

The shared modal has `role="dialog"` and a visible heading, with no accessible name connecting them. The stock-reset and bill-return dialogs were also present in the browser but could not be located by dialog name. A modal should announce its title, move focus inside, keep focus there, and return it on close. [Bank evidence](../../test-results/qa-audit/journeys-manager.json) · [Shared modal](../../frontend/src/components/ui.tsx#L19)

### QA-12 · Clear Store Stock misstates what will be deleted

As Owner, open **Inventory → Clear Store Stock**. The warning says it will delete “stock, breakage logs, and bills,” and the destructive button reads “Delete Everything.” The backend deletes **supplier invoices**, stock records, and related stock data. Sales bills are outside that operation. The success message also displays the returned `deletedInvoices` count as “bills removed.” A destructive confirmation should name supplier invoice history and sales history explicitly so the owner can tell which records will be affected. The QA check cancelled the operation. [Browser result](../../test-results/qa-audit/followup-branch.json) · [Confirmation and toast](../../frontend/src/inventory/Inventory.tsx#L174) · [Reset implementation](../../src/modules/inventory/inventory.service.ts#L325)

### QA-13 · Supplier invoice empty state points to an obsolete button label

On a branch with no supplier invoices, open **Supplier Invoices** as Manager. The empty state tells the user to click “Upload New Invoice.” The visible action is **Add Supplier Bill**, which is also rendered twice for this role on the empty list. The empty state should use the current action label and point to a single clear entry point. [Empty-state copy](../../frontend/src/invoices/InvoiceUpload.tsx#L1302)

## Page coverage

The navigation sweep made **69 route-and-role visits** across six seeded account types plus signed-out access. Every declared route opened under an applicable role. Each of the 31 routes received a first-load check at 1,440 px, 768 px, and 375 px. The role sweep also checked selected direct links that should redirect. Initial route loads showed no uncaught page exceptions in the sweep. The Inventory error occurred after interacting with the screen.

| Surface | Routes exercised |
|---|---|
| Signed out | `/login`, `/forgot-password`, `/reset-password` |
| Sales and customers | `/`, `/pos`, `/shift`, `/bills`, `/customers`, `/tables` |
| Catalog and stock | `/products`, `/invoices`, `/inventory`, `/menu/kitchen`, `/menu/bar`, `/counter`, `/pour` |
| Reporting and administration | `/schemes`, `/compliance`, `/accounting`, `/bank`, `/closing`, `/admin`, `/settings` |
| Super Admin | `/platform`, `/platform/roles`, `/platform/branches`, `/platform/plans`, `/platform/users`, `/platform/master`, `/platform/audit`, `/platform/errors` |

The deeper checks included invalid sign-in, password reset request feedback, cash checkout and shift totals, offline bill sync, cash return and bill history, khata sale and statement, supplier CSV draft creation and matching, bank account validation and statement preview, all nine Accounting tabs, an excise stock register download, staff access controls, mobile cart input, and Platform filters and forms. The audit covered navigation, selected workflows, and keyboard behavior in Chrome. Full browser and assistive-technology coverage, actual email delivery, live payment and printer integrations, and page-by-page business-rule exhaustiveness remain unverified.

Screenshots and raw browser observations used during the audit are in the local ignored `test-results/qa-audit/` directory.

## Fix verification

All 13 defects were fixed and passed their Playwright MCP reproductions against the rebuilt application on port 3313. The retest covered the original bank CSV, both parked-bill scenarios, the permission boundary, the three responsive layouts, and keyboard focus for the drawer, cart, and shared dialogs.

The production build passed, along with all 749 unit tests and 29 bank integration tests. [Final browser results](../../test-results/qa-audit/regressions.json)

## Follow-up UI audit

Playwright MCP rechecked all 31 routes at desktop, tablet, and phone widths, including 320 px. Accounting’s nine tabs, Products’ four tabs, and the Counter Stock Sheet fit at 375 px. The closed mobile drawer and cart stayed out of the keyboard tab order.

A seeded cashier without cost access saw no Supplier Invoices menu entry. Opening the URL directly redirected to the Dashboard. The upload form never appeared and the browser made no invoice API requests. A Manager completed the authorized flow on a 375 px viewport. CSV upload returned 201, review and approval returned 200, and history showed **Added to Stock** with a confirmation for two bottles. [Browser results](../../test-results/qa-audit/ui-followup.json)

### QA-14 · Keyboard focus can leave the open mobile drawer · P2

At 375 px, sign in as Owner, open Products, then open the navigation drawer. Focus starts on the drawer’s Close button. Tab through the drawer until focus reaches the Branch selector, Language selector, theme toggle, and Products controls behind the visible scrim. Escape closes the drawer and restores focus to its trigger. Keyboard focus should stay in the drawer while the scrim blocks the page. [Browser results](../../test-results/qa-audit/ui-followup.json) · [Drawer and scrim](../../frontend/src/components/Layout.tsx#L295)

### QA-15 · Opening the mobile cart loses focus and Escape can leave it open · P2

At 375 px, sign in as Cashier, search for Old Monk, add it, and open the cart with the bottom View button. Focus falls to the document body. The first Tab goes to the header’s navigation button behind the cart. With the search still populated, the first Escape clears the search and leaves the cart open. Clicking Close the cart leaves focus on the body. Opening the cart should move focus inside, background controls should stay out of the tab order, and closing should restore focus to the cart opener. [Browser results](../../test-results/qa-audit/ui-followup.json) · [POS Escape handling](../../frontend/src/pos/POS.tsx#L704)

### QA-16 · Three outlet pages overflow at 320 px · P2

Sign in as Owner and open each route at 320 px. The Inventory **All Types** selector extends to x=329, the Excise & Breakage **Filter** button to x=338, and the Customers & Khata **Search** button to x=323. Each page fits at 375 px. The filter and search controls should reflow within the 320 px viewport. [Viewport measurements](../../test-results/qa-audit/narrow-followup.json)

### QA-17 · Expanding CSV import pushes the Master Catalog sideways · P2

Sign in as Super Admin and open **Master Catalog → Add or refresh products (paste CSV)**. The expanded form makes the page 394 px wide at both 320 px and 375 px, with the **Import** button extending beyond the initial viewport. The collapsed screen fits at 375 px. The file picker and import action should wrap inside the expanded form. [Viewport measurements](../../test-results/qa-audit/narrow-followup.json) · [CSV import form](../../frontend/src/platform/PlatformMaster.tsx#L165)

This follow-up recorded the four new findings. The app code was unchanged during this pass.


### Follow-up fix verification

QA-14 through QA-17 were fixed and passed their Playwright MCP checks on the demo app at port 3314. Tab and Shift+Tab stay inside the open drawer and cart. Escape restores focus to the opener, preserves the POS search, and leaves sidebar links usable. Inventory, Excise & Breakage, and Customers & Khata fit and their controls work at 320 px. The expanded Master Catalog CSV form fits at 320 px and 375 px, and selecting a CSV enables its Import action.

The production build passed. [Follow-up regression results](../../test-results/qa-audit/followup-regressions.json)

