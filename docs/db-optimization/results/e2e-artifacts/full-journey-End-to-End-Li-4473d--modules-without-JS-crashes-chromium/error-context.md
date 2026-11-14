# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-journey.spec.ts >> End-to-End Liquor Counter Application Journeys >> Journey 4: Navigation across modules without JS crashes
- Location: tests\e2e\full-journey.spec.ts:90:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('#page-stock')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('#page-stock') with timeout 15000ms
  - waiting for locator('#page-stock')

```

```yaml
- complementary:
  - text: Liquor Counter MAIN-01 — Main Counter Branch
  - button "Close navigation sidebar"
  - navigation:
    - text: Overview
    - link "Dashboard":
      - /url: /
    - text: Sell
    - link "Billing (POS)":
      - /url: /pos
    - link "Cashier Shift":
      - /url: /shift
    - link "Bills":
      - /url: /bills
    - link "Tables & Orders (KOT)":
      - /url: /tables
    - link "Customers & Khata":
      - /url: /customers
    - text: Menu & Stock
    - link "Kitchen Menu":
      - /url: /menu/kitchen
    - link "Bar Menu":
      - /url: /menu/bar
    - link "Products":
      - /url: /products
    - link "Supplier Invoices":
      - /url: /invoices
    - link "Inventory":
      - /url: /inventory
    - link "Counter Stock Sheet":
      - /url: /counter
  - text: Counter Cashier (Cashier) cashier@liquor.com
  - button "Change password"
  - button "Sign out"
- banner:
  - button "Close navigation menu"
  - text: Inventory
  - button "Toggle dark/light theme": Light
- main:
  - region "Inventory Management":
    - heading "Inventory Management" [level=1]
    - paragraph: Live bottle counts, costs, margins and breakage tracking for this store.
    - button "Current Stock"
    - button "Move Stock (Counters)"
    - button "All Products 161"
    - button "In stock 161"
    - button "Low stock 0"
    - button "Out of stock 0"
    - button "Bottles on hand 8,253" [disabled]
    - textbox "Search product or brand…"
    - combobox:
      - option "All Types" [selected]
      - option "Beer"
      - option "Whisky"
      - option "Wine"
      - option "Vodka"
      - option "Rum"
      - option "Gin"
      - option "Brandy"
    - button "All"
    - button "In Stock"
    - button "Low Stock"
    - button "Out of Stock"
    - button "↻ Refresh"
    - button "Record Breakage"
    - table:
      - rowgroup:
        - row "Product Stock level MRP":
          - columnheader "Product"
          - columnheader "Stock level"
          - columnheader "MRP"
      - rowgroup:
        - row "Royal Challenge Premium Whisky 750ml Royal Challenge · 750ml · 12/cs 100 ₹850.00":
          - cell "Royal Challenge Premium Whisky 750ml Royal Challenge · 750ml · 12/cs"
          - cell "100"
          - cell "₹850.00"
        - row "Blenders Pride Rare Premium 750ml Blenders Pride · 750ml · 12/cs 100 ₹1050.00":
          - cell "Blenders Pride Rare Premium 750ml Blenders Pride · 750ml · 12/cs"
          - cell "100"
          - cell "₹1050.00"
        - row "Kingfisher Premium Lager Beer 650ml Kingfisher · 650ml · 12/cs 100 ₹180.00":
          - cell "Kingfisher Premium Lager Beer 650ml Kingfisher · 650ml · 12/cs"
          - cell "100"
          - cell "₹180.00"
        - row "Magic Moments Vodka 750ml Magic Moments · 750ml · 12/cs 100 ₹700.00":
          - cell "Magic Moments Vodka 750ml Magic Moments · 750ml · 12/cs"
          - cell "100"
          - cell "₹700.00"
        - row "Old Monk XXX Rum 750ml Old Monk · 750ml · 12/cs 100 ₹450.00":
          - cell "Old Monk XXX Rum 750ml Old Monk · 750ml · 12/cs"
          - cell "100"
          - cell "₹450.00"
        - row "McDowell's No 1 Luxury Whisky 90ml McDowell's No 1 · 90ml · 96/cs 50 ₹80.00":
          - cell "McDowell's No 1 Luxury Whisky 90ml McDowell's No 1 · 90ml · 96/cs"
          - cell "50"
          - cell "₹80.00"
        - row "McDowell's No 1 Luxury Whisky 180ml McDowell's No 1 · 180ml · 48/cs 50 ₹180.00":
          - cell "McDowell's No 1 Luxury Whisky 180ml McDowell's No 1 · 180ml · 48/cs"
          - cell "50"
          - cell "₹180.00"
        - row "McDowell's No 1 Luxury Whisky 375ml McDowell's No 1 · 375ml · 24/cs 50 ₹350.00":
          - cell "McDowell's No 1 Luxury Whisky 375ml McDowell's No 1 · 375ml · 24/cs"
          - cell "50"
          - cell "₹350.00"
        - row "McDowell's No 1 Luxury Whisky 750ml McDowell's No 1 · 750ml · 12/cs 50 ₹700.00":
          - cell "McDowell's No 1 Luxury Whisky 750ml McDowell's No 1 · 750ml · 12/cs"
          - cell "50"
          - cell "₹700.00"
        - row "McDowell's No 1 Luxury Whisky 1000ml McDowell's No 1 · 1000ml · 9/cs 50 ₹950.00":
          - cell "McDowell's No 1 Luxury Whisky 1000ml McDowell's No 1 · 1000ml · 9/cs"
          - cell "50"
          - cell "₹950.00"
        - row "Old Admiral Special VSOP Brandy 180ml Old Admiral · 180ml · 48/cs 50 ₹120.00":
          - cell "Old Admiral Special VSOP Brandy 180ml Old Admiral · 180ml · 48/cs"
          - cell "50"
          - cell "₹120.00"
        - row "Old Monk Rum Very Old Vatted 180ml Old Monk · 180ml · 48/cs 50 ₹170.00":
          - cell "Old Monk Rum Very Old Vatted 180ml Old Monk · 180ml · 48/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Old Monk Very Old Vatted Rum 375ml Old Monk · 375ml · 24/cs 50 ₹330.00":
          - cell "Old Monk Very Old Vatted Rum 375ml Old Monk · 375ml · 24/cs"
          - cell "50"
          - cell "₹330.00"
        - row "Old Monk Rum Very Old Vatted 750ml Old Monk · 750ml · 12/cs 50 ₹690.00":
          - cell "Old Monk Rum Very Old Vatted 750ml Old Monk · 750ml · 12/cs"
          - cell "50"
          - cell "₹690.00"
        - row "Absolut Raspberri Flavoured Vodka 200ml Absolut · 200ml · 24/cs 50 ₹810.00":
          - cell "Absolut Raspberri Flavoured Vodka 200ml Absolut · 200ml · 24/cs"
          - cell "50"
          - cell "₹810.00"
        - row "Absolut Raspberri 750ml Absolut Raspberri · 750ml · 12/cs 50 ₹2560.00":
          - cell "Absolut Raspberri 750ml Absolut Raspberri · 750ml · 12/cs"
          - cell "50"
          - cell "₹2560.00"
        - row "Officer's Choice Reserve Whisky 90ml Officer's Choice · 90ml · 96/cs 50 ₹80.00":
          - cell "Officer's Choice Reserve Whisky 90ml Officer's Choice · 90ml · 96/cs"
          - cell "50"
          - cell "₹80.00"
        - 'row "Officer`s Choice Reserve Whisky 180ml Officer`s Choice Reserve · 180ml · 48/cs 50 ₹150.00"':
          - 'cell "Officer`s Choice Reserve Whisky 180ml Officer`s Choice Reserve · 180ml · 48/cs"'
          - cell "50"
          - cell "₹150.00"
        - 'row "Officer`s Choice Reserve Whisky 375ml Officer`s Choice Reserve · 375ml · 24/cs 50 ₹300.00"':
          - 'cell "Officer`s Choice Reserve Whisky 375ml Officer`s Choice Reserve · 375ml · 24/cs"'
          - cell "50"
          - cell "₹300.00"
        - 'row "Officer`s Choice Reserve Whisky 750ml Officer`s Choice Reserve · 750ml · 12/cs 50 ₹600.00"':
          - 'cell "Officer`s Choice Reserve Whisky 750ml Officer`s Choice Reserve · 750ml · 12/cs"'
          - cell "50"
          - cell "₹600.00"
        - row "Teachers 50 Blended Scotch Whisky 180ml Teachers 50 · 180ml · 48/cs 50 ₹820.00":
          - cell "Teachers 50 Blended Scotch Whisky 180ml Teachers 50 · 180ml · 48/cs"
          - cell "50"
          - cell "₹820.00"
        - row "Teachers 50 Blended Scotch Whisky 375ml Teachers 50 · 375ml · 24/cs 50 ₹1640.00":
          - cell "Teachers 50 Blended Scotch Whisky 375ml Teachers 50 · 375ml · 24/cs"
          - cell "50"
          - cell "₹1640.00"
        - row "Teacher's 50 Blended Scotch Whisky 750ml Teacher's · 750ml · 12/cs 50 ₹3160.00":
          - cell "Teacher's 50 Blended Scotch Whisky 750ml Teacher's · 750ml · 12/cs"
          - cell "50"
          - cell "₹3160.00"
        - row "Teachers Highland Cream Blended Scotch Whisky 60ml Teachers Highland Cream · 60ml · 150/cs 50 ₹200.00":
          - cell "Teachers Highland Cream Blended Scotch Whisky 60ml Teachers Highland Cream · 60ml · 150/cs"
          - cell "50"
          - cell "₹200.00"
        - row "Teachers Highland Cream Blended Scotch Whisky Teachers 180ml Teachers Highland Cream · 180ml · 48/cs 50 ₹580.00":
          - cell "Teachers Highland Cream Blended Scotch Whisky Teachers 180ml Teachers Highland Cream · 180ml · 48/cs"
          - cell "50"
          - cell "₹580.00"
        - row "Highland Cream Blended Scotch Whisky 375ml Highland Cream · 375ml · 24/cs 50 ₹1160.00":
          - cell "Highland Cream Blended Scotch Whisky 375ml Highland Cream · 375ml · 24/cs"
          - cell "50"
          - cell "₹1160.00"
        - row "Teacher's Highland Cream Blended Scotch Whisky 750ml Teacher's · 750ml · 12/cs 50 ₹2240.00":
          - cell "Teacher's Highland Cream Blended Scotch Whisky 750ml Teacher's · 750ml · 12/cs"
          - cell "50"
          - cell "₹2240.00"
        - row "Ti Mansion House Gold Whisky 180ml Ti Mansion House · 180ml · 48/cs 50 ₹210.00":
          - cell "Ti Mansion House Gold Whisky 180ml Ti Mansion House · 180ml · 48/cs"
          - cell "50"
          - cell "₹210.00"
        - row "Ti Mansion House Gold Whisky 375ml Ti Mansion House · 375ml · 24/cs 50 ₹430.00":
          - cell "Ti Mansion House Gold Whisky 375ml Ti Mansion House · 375ml · 24/cs"
          - cell "50"
          - cell "₹430.00"
        - row "Mansion House Gold Whisky 750ml Mansion House · 750ml · 12/cs 50 ₹830.00":
          - cell "Mansion House Gold Whisky 750ml Mansion House · 750ml · 12/cs"
          - cell "50"
          - cell "₹830.00"
        - 'row "Seagram`s Imperial Blue Classic Grain Whisky 90ml Seagram`s Imperial Blue · 90ml · 96/cs 50 ₹80.00"':
          - 'cell "Seagram`s Imperial Blue Classic Grain Whisky 90ml Seagram`s Imperial Blue · 90ml · 96/cs"'
          - cell "50"
          - cell "₹80.00"
        - row "Imperial Blue Classic Grain Whisky 180ml Imperial Blue · 180ml · 48/cs 50 ₹160.00":
          - cell "Imperial Blue Classic Grain Whisky 180ml Imperial Blue · 180ml · 48/cs"
          - cell "50"
          - cell "₹160.00"
        - 'row "Seagram`s Imperial Blue Classic Grain Whisky 375ml Seagram`s Imperial Blue · 375ml · 24/cs 50 ₹340.00"':
          - 'cell "Seagram`s Imperial Blue Classic Grain Whisky 375ml Seagram`s Imperial Blue · 375ml · 24/cs"'
          - cell "50"
          - cell "₹340.00"
        - 'row "Seagram`s Imperial Blue Classic Grain Whisky 750ml Seagram`s Imperial Blue · 750ml · 12/cs 50 ₹690.00"':
          - 'cell "Seagram`s Imperial Blue Classic Grain Whisky 750ml Seagram`s Imperial Blue · 750ml · 12/cs"'
          - cell "50"
          - cell "₹690.00"
        - 'row "Seagram`s Royal Stag Blended Whisky 90ml Seagram`s Royal Stag · 90ml · 96/cs 50 ₹100.00"':
          - 'cell "Seagram`s Royal Stag Blended Whisky 90ml Seagram`s Royal Stag · 90ml · 96/cs"'
          - cell "50"
          - cell "₹100.00"
        - 'row "Seagram`s Royal Stag Blended Whisky 375ml Seagram`s Royal Stag · 375ml · 24/cs 50 ₹410.00"':
          - 'cell "Seagram`s Royal Stag Blended Whisky 375ml Seagram`s Royal Stag · 375ml · 24/cs"'
          - cell "50"
          - cell "₹410.00"
        - 'row "Seagram`s Royal Stag Blended Whisky 1000ml Seagram`s Royal Stag · 1000ml · 9/cs 50 ₹1080.00"':
          - 'cell "Seagram`s Royal Stag Blended Whisky 1000ml Seagram`s Royal Stag · 1000ml · 9/cs"'
          - cell "50"
          - cell "₹1080.00"
        - row "Royal Stag Blended Whisky 2000ml Royal Stag · 2000ml · 4/cs 50 ₹2060.00":
          - cell "Royal Stag Blended Whisky 2000ml Royal Stag · 2000ml · 4/cs"
          - cell "50"
          - cell "₹2060.00"
        - row "Teacher's Aged 12 Years Golden Thistle Scotch Whisky 750ml Teacher's · 750ml · 12/cs 50 ₹3440.00":
          - cell "Teacher's Aged 12 Years Golden Thistle Scotch Whisky 750ml Teacher's · 750ml · 12/cs"
          - cell "50"
          - cell "₹3440.00"
        - row "Sterling Reserve B7 Select Blended Whisky 180ml Sterling Reserve · 180ml · 48/cs 50 ₹190.00":
          - cell "Sterling Reserve B7 Select Blended Whisky 180ml Sterling Reserve · 180ml · 48/cs"
          - cell "50"
          - cell "₹190.00"
        - row "Royal Challenge Classic Malt Whisky 180ml Royal Challenge · 180ml · 48/cs 50 ₹280.00":
          - cell "Royal Challenge Classic Malt Whisky 180ml Royal Challenge · 180ml · 48/cs"
          - cell "50"
          - cell "₹280.00"
        - row "Signature Ultra Premier Grain Whisky 375ml Signature · 375ml · 24/cs 50 ₹640.00":
          - cell "Signature Ultra Premier Grain Whisky 375ml Signature · 375ml · 24/cs"
          - cell "50"
          - cell "₹640.00"
        - 'row "Seagram`s Blenders Pride Select Pr. Whisky 90ml Seagram`s Blenders Pride · 90ml · 96/cs 50 ₹170.00"':
          - 'cell "Seagram`s Blenders Pride Select Pr. Whisky 90ml Seagram`s Blenders Pride · 90ml · 96/cs"'
          - cell "50"
          - cell "₹170.00"
        - 'row "Seagram`s Blenders Pride Select Pr. Whisky 180ml Seagram`s Blenders Pride · 180ml · 48/cs 50 ₹330.00"':
          - 'cell "Seagram`s Blenders Pride Select Pr. Whisky 180ml Seagram`s Blenders Pride · 180ml · 48/cs"'
          - cell "50"
          - cell "₹330.00"
        - 'row "Seagram`s Blenders Pride Select Pr. Whisky 375ml Seagram`s Blenders Pride · 375ml · 24/cs 50 ₹670.00"':
          - 'cell "Seagram`s Blenders Pride Select Pr. Whisky 375ml Seagram`s Blenders Pride · 375ml · 24/cs"'
          - cell "50"
          - cell "₹670.00"
        - row "Blenders Pride Select Premium Whisky 750ml Blenders Pride · 750ml · 12/cs 50 ₹1290.00":
          - cell "Blenders Pride Select Premium Whisky 750ml Blenders Pride · 750ml · 12/cs"
          - cell "50"
          - cell "₹1290.00"
        - 'row "Seagram`s Blenders Pride Select Pr. Whisky 1000ml Seagram`s Blenders Pride · 1000ml · 9/cs 50 ₹1740.00"':
          - 'cell "Seagram`s Blenders Pride Select Pr. Whisky 1000ml Seagram`s Blenders Pride · 1000ml · 9/cs"'
          - cell "50"
          - cell "₹1740.00"
        - 'row "Seagram`s Blenders Pride Select Pr. Whisky 2000ml Seagram`s Blenders Pride · 2000ml · 4/cs 50 ₹13830.00"':
          - 'cell "Seagram`s Blenders Pride Select Pr. Whisky 2000ml Seagram`s Blenders Pride · 2000ml · 4/cs"'
          - cell "50"
          - cell "₹13830.00"
        - row "Maqintosh Silver Edition Whisky 750ml Maqintosh Silver · 750ml · 12/cs 50 ₹1410.00":
          - cell "Maqintosh Silver Edition Whisky 750ml Maqintosh Silver · 750ml · 12/cs"
          - cell "50"
          - cell "₹1410.00"
        - row "8pm Premium Black Whisky Jim Beam 180ml 8PM · 180ml · 48/cs 49 ₹190.00":
          - cell "8pm Premium Black Whisky Jim Beam 180ml 8PM · 180ml · 48/cs"
          - cell "49"
          - cell "₹190.00"
        - row "8pm Premium Black Whisky Jim Beam 375ml 8pm Premium Black · 375ml · 24/cs 50 ₹410.00":
          - cell "8pm Premium Black Whisky Jim Beam 375ml 8pm Premium Black · 375ml · 24/cs"
          - cell "50"
          - cell "₹410.00"
        - row "Kentucky Straight Bourbon Whiskey 750ml Kentucky Straight · 750ml · 6/cs 50 ₹2620.00":
          - cell "Kentucky Straight Bourbon Whiskey 750ml Kentucky Straight · 750ml · 6/cs"
          - cell "50"
          - cell "₹2620.00"
        - row "Antiquity Blue Ultra Premium Whisky 180ml Antiquity · 180ml · 48/cs 50 ₹340.00":
          - cell "Antiquity Blue Ultra Premium Whisky 180ml Antiquity · 180ml · 48/cs"
          - cell "50"
          - cell "₹340.00"
        - row "Antiquity Blue Ultra Pre Mium Whisky 375ml Antiquity Blue Ultra · 375ml · 24/cs 50 ₹720.00":
          - cell "Antiquity Blue Ultra Pre Mium Whisky 375ml Antiquity Blue Ultra · 375ml · 24/cs"
          - cell "50"
          - cell "₹720.00"
        - row "Ti Mansion House Xo Bran Dy 90ml Ti Mansion House · 90ml · 96/cs 50 ₹80.00":
          - cell "Ti Mansion House Xo Bran Dy 90ml Ti Mansion House · 90ml · 96/cs"
          - cell "50"
          - cell "₹80.00"
        - row "Ti Mansion House Xo Bran Dy 180ml Ti Mansion House · 180ml · 48/cs 50 ₹160.00":
          - cell "Ti Mansion House Xo Bran Dy 180ml Ti Mansion House · 180ml · 48/cs"
          - cell "50"
          - cell "₹160.00"
        - row "Mansion House XO Brandy 375ml Mansion House · 375ml · 24/cs 50 ₹320.00":
          - cell "Mansion House XO Brandy 375ml Mansion House · 375ml · 24/cs"
          - cell "50"
          - cell "₹320.00"
        - row "Ti Mansion House Xo Bran Dy 750ml Ti Mansion House · 750ml · 12/cs 50 ₹660.00":
          - cell "Ti Mansion House Xo Bran Dy 750ml Ti Mansion House · 750ml · 12/cs"
          - cell "50"
          - cell "₹660.00"
        - row "Ti Mansion House Xo Bran Dy 1000ml Ti Mansion House · 1000ml · 9/cs 50 ₹890.00":
          - cell "Ti Mansion House Xo Bran Dy 1000ml Ti Mansion House · 1000ml · 9/cs"
          - cell "50"
          - cell "₹890.00"
        - row "Ti Mansion House Xo Bran Dy 2000ml Ti Mansion House · 2000ml · 4/cs 50 ₹1790.00":
          - cell "Ti Mansion House Xo Bran Dy 2000ml Ti Mansion House · 2000ml · 4/cs"
          - cell "50"
          - cell "₹1790.00"
        - row "Kay Kay Fine Whisky 180ml Kay Kay · 180ml · 48/cs 50 ₹100.00":
          - cell "Kay Kay Fine Whisky 180ml Kay Kay · 180ml · 48/cs"
          - cell "50"
          - cell "₹100.00"
        - row "Deccan Blue Whisky 180ml Deccan Blue · 180ml · 48/cs 50 ₹100.00":
          - cell "Deccan Blue Whisky 180ml Deccan Blue · 180ml · 48/cs"
          - cell "50"
          - cell "₹100.00"
        - row "Deccan Blue Whisky 1000ml Deccan Blue · 1000ml · 9/cs 50 ₹570.00":
          - cell "Deccan Blue Whisky 1000ml Deccan Blue · 1000ml · 9/cs"
          - cell "50"
          - cell "₹570.00"
        - row "Oaksmith International Blended Whisky 180ml Oaksmith · 180ml · 48/cs 50 ₹230.00":
          - cell "Oaksmith International Blended Whisky 180ml Oaksmith · 180ml · 48/cs"
          - cell "50"
          - cell "₹230.00"
        - row "Oaksmith International Blended Whisky 375ml Oaksmith International · 375ml · 24/cs 50 ₹490.00":
          - cell "Oaksmith International Blended Whisky 375ml Oaksmith International · 375ml · 24/cs"
          - cell "50"
          - cell "₹490.00"
        - row "Oaksmith International Blended Whisky 750ml Oaksmith International · 750ml · 12/cs 50 ₹990.00":
          - cell "Oaksmith International Blended Whisky 750ml Oaksmith International · 750ml · 12/cs"
          - cell "50"
          - cell "₹990.00"
        - row "Oaksmith Gold International Blended Whisky 180ml Oaksmith · 180ml · 48/cs 50 ₹350.00":
          - cell "Oaksmith Gold International Blended Whisky 180ml Oaksmith · 180ml · 48/cs"
          - cell "50"
          - cell "₹350.00"
        - row "Oaksmith Gold International Blended Whisky 375ml Oaksmith Gold International · 375ml · 24/cs 50 ₹730.00":
          - cell "Oaksmith Gold International Blended Whisky 375ml Oaksmith Gold International · 375ml · 24/cs"
          - cell "50"
          - cell "₹730.00"
        - row "Oaksmith Gold International Blended Whisky 750ml Oaksmith Gold International · 750ml · 12/cs 50 ₹1470.00":
          - cell "Oaksmith Gold International Blended Whisky 750ml Oaksmith Gold International · 750ml · 12/cs"
          - cell "50"
          - cell "₹1470.00"
        - row "Paul John Indian Single Malt Whisky Nirvana Unpeated Single Malt Whisky 750ml Paul John · 750ml · 12/cs 50 ₹2970.00":
          - cell "Paul John Indian Single Malt Whisky Nirvana Unpeated Single Malt Whisky 750ml Paul John · 750ml · 12/cs"
          - cell "50"
          - cell "₹2970.00"
        - row "Morpheus Blue XO Premium Brandy 750ml Morpheus · 750ml · 12/cs 50 ₹1490.00":
          - cell "Morpheus Blue XO Premium Brandy 750ml Morpheus · 750ml · 12/cs"
          - cell "50"
          - cell "₹1490.00"
        - row "Magic Moments Verve Green Apple Vodka 750ml Magic Moments · 750ml · 6/cs 50 ₹1160.00":
          - cell "Magic Moments Verve Green Apple Vodka 750ml Magic Moments · 750ml · 6/cs"
          - cell "50"
          - cell "₹1160.00"
        - row "Maltage Aged Malt Whisky 750ml Maltage Aged · 750ml · 12/cs 50 ₹1290.00":
          - cell "Maltage Aged Malt Whisky 750ml Maltage Aged · 750ml · 12/cs"
          - cell "50"
          - cell "₹1290.00"
        - row "The Three Monkeys Indian Single Malt Whisky 750ml The Three · 750ml · 12/cs 50 ₹2120.00":
          - cell "The Three Monkeys Indian Single Malt Whisky 750ml The Three · 750ml · 12/cs"
          - cell "50"
          - cell "₹2120.00"
        - row "Apple Flavoured Oasis London High Tripple Distilled English Vodka Green Apple Flavoured Oasis London 180ml Apple Flavoured · 180ml · 48/cs 50 ₹180.00":
          - cell "Apple Flavoured Oasis London High Tripple Distilled English Vodka Green Apple Flavoured Oasis London 180ml Apple Flavoured · 180ml · 48/cs"
          - cell "50"
          - cell "₹180.00"
        - row "Oasis London High Tripple Distilled English Vodka Green Apple Flavoured 375ml Oasis London High · 375ml · 24/cs 50 ₹380.00":
          - cell "Oasis London High Tripple Distilled English Vodka Green Apple Flavoured 375ml Oasis London High · 375ml · 24/cs"
          - cell "50"
          - cell "₹380.00"
        - row "High Tripple Distilled English Vodka Green Apple Flavoured 750ml High Tripple Distilled · 750ml · 12/cs 50 ₹770.00":
          - cell "High Tripple Distilled English Vodka Green Apple Flavoured 750ml High Tripple Distilled · 750ml · 12/cs"
          - cell "50"
          - cell "₹770.00"
        - row "Lucifer's Gold Whisky 700ml Lucifer's Gold · 700ml · 6/cs 50 ₹2960.00":
          - cell "Lucifer's Gold Whisky 700ml Lucifer's Gold · 700ml · 6/cs"
          - cell "50"
          - cell "₹2960.00"
        - row "Royal Challenge Blended Whisky 180ml Royal Challenge · 180ml · 48/cs 50 ₹200.00":
          - cell "Royal Challenge Blended Whisky 180ml Royal Challenge · 180ml · 48/cs"
          - cell "50"
          - cell "₹200.00"
        - row "Royal Challenge Blended Whisky 375ml Royal Challenge · 375ml · 24/cs 50 ₹390.00":
          - cell "Royal Challenge Blended Whisky 375ml Royal Challenge · 375ml · 24/cs"
          - cell "50"
          - cell "₹390.00"
        - row "Bro Code Brut Sparkling Wine 375ml Bro Code · 375ml · 24/cs 50 ₹370.00":
          - cell "Bro Code Brut Sparkling Wine 375ml Bro Code · 375ml · 24/cs"
          - cell "50"
          - cell "₹370.00"
        - row "Dewars Blended Scotch Whisky White Label 180ml Dewars Blended · 180ml · 48/cs 50 ₹560.00":
          - cell "Dewars Blended Scotch Whisky White Label 180ml Dewars Blended · 180ml · 48/cs"
          - cell "50"
          - cell "₹560.00"
        - row "Bushmills Original Irish Whiskey 700ml Bushmills · 700ml · 12/cs 50 ₹3160.00":
          - cell "Bushmills Original Irish Whiskey 700ml Bushmills · 700ml · 12/cs"
          - cell "50"
          - cell "₹3160.00"
        - row "Teacher's Highland Cream Reserve Scotch Whisky 180ml Teacher's · 750ml · 12/cs 50 ₹2870.00":
          - cell "Teacher's Highland Cream Reserve Scotch Whisky 180ml Teacher's · 750ml · 12/cs"
          - cell "50"
          - cell "₹2870.00"
        - row "Tenjaku Whisky 700ml Tenjaku Whisky · 700ml · 12/cs 50 ₹4070.00":
          - cell "Tenjaku Whisky 700ml Tenjaku Whisky · 700ml · 12/cs"
          - cell "50"
          - cell "₹4070.00"
        - row "Bacardi Gold Cranberry Flavoured Rum 750ml Bacardi · 275ml · 24/cs 50 ₹130.00":
          - cell "Bacardi Gold Cranberry Flavoured Rum 750ml Bacardi · 275ml · 24/cs"
          - cell "50"
          - cell "₹130.00"
        - row "Royal Green Supreme Blended Whisky 180ml Royal Green · 180ml · 48/cs 50 ₹190.00":
          - cell "Royal Green Supreme Blended Whisky 180ml Royal Green · 180ml · 48/cs"
          - cell "50"
          - cell "₹190.00"
        - row "Royal Green Supreme Blended Whisky 750ml Royal Green Supreme · 750ml · 12/cs 50 ₹820.00":
          - cell "Royal Green Supreme Blended Whisky 750ml Royal Green Supreme · 750ml · 12/cs"
          - cell "50"
          - cell "₹820.00"
        - row "Johnnie Walker Blonde Blended Scotch Whisky 200ml Johnnie Walker · 200ml · 24/cs 50 ₹770.00":
          - cell "Johnnie Walker Blonde Blended Scotch Whisky 200ml Johnnie Walker · 200ml · 24/cs"
          - cell "50"
          - cell "₹770.00"
        - row "Mansion House Flandy Orange Flavoured Brandy 180ml Mansion House · 180ml · 48/cs 50 ₹190.00":
          - cell "Mansion House Flandy Orange Flavoured Brandy 180ml Mansion House · 180ml · 48/cs"
          - cell "50"
          - cell "₹190.00"
        - row "Seagram's 100 Pipers Exquisite Blended Scotch Whisky 180ml 100 Pipers · 180ml · 48/cs 50 ₹520.00":
          - cell "Seagram's 100 Pipers Exquisite Blended Scotch Whisky 180ml 100 Pipers · 180ml · 48/cs"
          - cell "50"
          - cell "₹520.00"
        - 'row "Seagram`s 100 Pipers Exquisite Blended Scotch Whisky 375ml Seagram`s 100 Pipers · 375ml · 24/cs 50 ₹1080.00"':
          - 'cell "Seagram`s 100 Pipers Exquisite Blended Scotch Whisky 375ml Seagram`s 100 Pipers · 375ml · 24/cs"'
          - cell "50"
          - cell "₹1080.00"
        - 'row "Seagram`s 100 Pipers Exquisite Blended Scotch Whisky 750ml Seagram`s 100 Pipers · 750ml · 12/cs 50 ₹2160.00"':
          - 'cell "Seagram`s 100 Pipers Exquisite Blended Scotch Whisky 750ml Seagram`s 100 Pipers · 750ml · 12/cs"'
          - cell "50"
          - cell "₹2160.00"
        - row "Iconiq White Select International Grain Whisky 180ml Iconiq White Select · 180ml · 48/cs 50 ₹170.00":
          - cell "Iconiq White Select International Grain Whisky 180ml Iconiq White Select · 180ml · 48/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Iconiq White Select International Grain Whisky 375ml Iconiq White Select · 375ml · 24/cs 50 ₹340.00":
          - cell "Iconiq White Select International Grain Whisky 375ml Iconiq White Select · 375ml · 24/cs"
          - cell "50"
          - cell "₹340.00"
        - row "Iconiq White Select International Grain Whisky 750ml Iconiq White · 750ml · 12/cs 50 ₹660.00":
          - cell "Iconiq White Select International Grain Whisky 750ml Iconiq White · 750ml · 12/cs"
          - cell "50"
          - cell "₹660.00"
        - row "Opera Premium Red Wine 180ml Opera Premium · 180ml · 48/cs 50 ₹190.00":
          - cell "Opera Premium Red Wine 180ml Opera Premium · 180ml · 48/cs"
          - cell "50"
          - cell "₹190.00"
        - 'row "Ballantine`s Finest Blended Scotch Whisky 375ml Ballantine`s Finest · 375ml · 24/cs 50 ₹1380.00"':
          - 'cell "Ballantine`s Finest Blended Scotch Whisky 375ml Ballantine`s Finest · 375ml · 24/cs"'
          - cell "50"
          - cell "₹1380.00"
        - row "Ballantine's Finest Blended Scotch Whisky 750ml Ballantine's Finest · 750ml · 12/cs 50 ₹2660.00":
          - cell "Ballantine's Finest Blended Scotch Whisky 750ml Ballantine's Finest · 750ml · 12/cs"
          - cell "50"
          - cell "₹2660.00"
        - row "Smirnoff Triple Distilled Vodka 180ml Smirnoff Triple Distilled · 180ml · 48/cs 50 ₹300.00":
          - cell "Smirnoff Triple Distilled Vodka 180ml Smirnoff Triple Distilled · 180ml · 48/cs"
          - cell "50"
          - cell "₹300.00"
        - row "Smirnoff Triple Distilled Vodka 750ml Smirnoff · 750ml · 12/cs 50 ₹1160.00":
          - cell "Smirnoff Triple Distilled Vodka 750ml Smirnoff · 750ml · 12/cs"
          - cell "50"
          - cell "₹1160.00"
        - row "King Palace Deluxe Whisky 180ml King Palace · 180ml · 48/cs 50 ₹100.00":
          - cell "King Palace Deluxe Whisky 180ml King Palace · 180ml · 48/cs"
          - cell "50"
          - cell "₹100.00"
        - row "King Palace Deluxe Whisky 1000ml King Palace Deluxe · 1000ml · 9/cs 50 ₹560.00":
          - cell "King Palace Deluxe Whisky 1000ml King Palace Deluxe · 1000ml · 9/cs"
          - cell "50"
          - cell "₹560.00"
        - 'row "Seagram`s Xclamation Reserve Whisky 180ml Seagram`s Xclamation Reserve · 180ml · 48/cs 50 ₹290.00"':
          - 'cell "Seagram`s Xclamation Reserve Whisky 180ml Seagram`s Xclamation Reserve · 180ml · 48/cs"'
          - cell "50"
          - cell "₹290.00"
        - 'row "Seagram`s Xclamation Reserve Whisky 375ml Seagram`s Xclamation Reserve · 375ml · 24/cs 50 ₹580.00"':
          - 'cell "Seagram`s Xclamation Reserve Whisky 375ml Seagram`s Xclamation Reserve · 375ml · 24/cs"'
          - cell "50"
          - cell "₹580.00"
        - row "Seagram's Xclamation Reserve Whisky 750ml Seagram's Xclamation · 750ml · 12/cs 50 ₹1120.00":
          - cell "Seagram's Xclamation Reserve Whisky 750ml Seagram's Xclamation · 750ml · 12/cs"
          - cell "50"
          - cell "₹1120.00"
        - row "Sumo Supreme Whisky 180ml Sumo Supreme · 180ml · 48/cs 50 ₹100.00":
          - cell "Sumo Supreme Whisky 180ml Sumo Supreme · 180ml · 48/cs"
          - cell "50"
          - cell "₹100.00"
        - row "Seagram's Xclamation Reserve Vodka 750ml Seagram's Xclamation · 750ml · 12/cs 50 ₹1120.00":
          - cell "Seagram's Xclamation Reserve Vodka 750ml Seagram's Xclamation · 750ml · 12/cs"
          - cell "50"
          - cell "₹1120.00"
        - row "Whistler Barrel Aged Blended Malt Whisky 750ml Whistler Barrel · 750ml · 12/cs 50 ₹1410.00":
          - cell "Whistler Barrel Aged Blended Malt Whisky 750ml Whistler Barrel · 750ml · 12/cs"
          - cell "50"
          - cell "₹1410.00"
        - row "Magic Moments Jamun Spicymint Vivid Vodka 180ml Magic Moments · 180ml · 48/cs 50 ₹190.00":
          - cell "Magic Moments Jamun Spicymint Vivid Vodka 180ml Magic Moments · 180ml · 48/cs"
          - cell "50"
          - cell "₹190.00"
        - row "Magic Moments Jamun Spicymint Vivid Flavoured Vodka 375ml Magic Moments Jamun · 375ml · 24/cs 50 ₹410.00":
          - cell "Magic Moments Jamun Spicymint Vivid Flavoured Vodka 375ml Magic Moments Jamun · 375ml · 24/cs"
          - cell "50"
          - cell "₹410.00"
        - row "Magic Moments Jamun Spicymint Vivid Flavoured Vodka 750ml Magic Moments Jamun · 750ml · 12/cs 50 ₹820.00":
          - cell "Magic Moments Jamun Spicymint Vivid Flavoured Vodka 750ml Magic Moments Jamun · 750ml · 12/cs"
          - cell "50"
          - cell "₹820.00"
        - row "Jameson Triple Triple Irish Whiskey 750ml Jameson · 750ml · 12/cs 50 ₹3710.00":
          - cell "Jameson Triple Triple Irish Whiskey 750ml Jameson · 750ml · 12/cs"
          - cell "50"
          - cell "₹3710.00"
        - row "Blenders Pride Four Elements Rare Whisky 180ml Blenders Pride Four · 180ml · 48/cs 50 ₹350.00":
          - cell "Blenders Pride Four Elements Rare Whisky 180ml Blenders Pride Four · 180ml · 48/cs"
          - cell "50"
          - cell "₹350.00"
        - 'row "Seagram`s Blenders Pride Four Elements Rare Whisky 375ml Seagram`s Blenders Pride · 375ml · 24/cs 50 ₹720.00"':
          - 'cell "Seagram`s Blenders Pride Four Elements Rare Whisky 375ml Seagram`s Blenders Pride · 375ml · 24/cs"'
          - cell "50"
          - cell "₹720.00"
        - row "Blenders Pride Four Elements Rare Whisky 750ml Blenders Pride · 750ml · 12/cs 50 ₹1380.00":
          - cell "Blenders Pride Four Elements Rare Whisky 750ml Blenders Pride · 750ml · 12/cs"
          - cell "50"
          - cell "₹1380.00"
        - row "Jacob's Creek Classic Merlot Red Wine 750ml Jacob's Creek · 750ml · 12/cs 50 ₹2130.00":
          - cell "Jacob's Creek Classic Merlot Red Wine 750ml Jacob's Creek · 750ml · 12/cs"
          - cell "50"
          - cell "₹2130.00"
        - row "Sula Cabernet Shiraz Red Wine 750ml Sula · 750ml · 12/cs 50 ₹1120.00":
          - cell "Sula Cabernet Shiraz Red Wine 750ml Sula · 750ml · 12/cs"
          - cell "50"
          - cell "₹1120.00"
        - row "Sula Chenin Blanc White Wine 750ml Sula · 750ml · 12/cs 50 ₹1040.00":
          - cell "Sula Chenin Blanc White Wine 750ml Sula · 750ml · 12/cs"
          - cell "50"
          - cell "₹1040.00"
        - row "Jacob's Creek Classic Shiraz Cabernet 750ml Jacob's Creek · 750ml · 12/cs 50 ₹2060.00":
          - cell "Jacob's Creek Classic Shiraz Cabernet 750ml Jacob's Creek · 750ml · 12/cs"
          - cell "50"
          - cell "₹2060.00"
        - row "Kingfisher Premium Lager Beer 650ml Kingfisher · 650ml · 12/cs 49 ₹160.00":
          - cell "Kingfisher Premium Lager Beer 650ml Kingfisher · 650ml · 12/cs"
          - cell "49"
          - cell "₹160.00"
        - row "Kingfisher Strong Premium Beer 650ml Kingfisher · 650ml · 12/cs 50 ₹170.00":
          - cell "Kingfisher Strong Premium Beer 650ml Kingfisher · 650ml · 12/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Budweiser King Of Beers 330ml Budweiser King Of · 330ml · 24/cs 50 ₹140.00":
          - cell "Budweiser King Of Beers 330ml Budweiser King Of · 330ml · 24/cs"
          - cell "50"
          - cell "₹140.00"
        - row "Budweiser King Of Beers 500ml Budweiser King Of · 500ml · 24/cs 50 ₹190.00":
          - cell "Budweiser King Of Beers 500ml Budweiser King Of · 500ml · 24/cs"
          - cell "50"
          - cell "₹190.00"
        - row "Budweiser King of Beers 650ml Budweiser · 650ml · 12/cs 50 ₹230.00":
          - cell "Budweiser King of Beers 650ml Budweiser · 650ml · 12/cs"
          - cell "50"
          - cell "₹230.00"
        - row "Royal Challenge Premium Lager Beer 650ml Royal Challenge · 650ml · 12/cs 50 ₹160.00":
          - cell "Royal Challenge Premium Lager Beer 650ml Royal Challenge · 650ml · 12/cs"
          - cell "50"
          - cell "₹160.00"
        - row "Haywards 5000 Super Strong Beer 650ml Haywards 5000 · 650ml · 12/cs 50 ₹170.00":
          - cell "Haywards 5000 Super Strong Beer 650ml Haywards 5000 · 650ml · 12/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Kingfisher Ultra Lager Beer 330ml Kingfisher Ultra · 330ml · 24/cs 50 ₹140.00":
          - cell "Kingfisher Ultra Lager Beer 330ml Kingfisher Ultra · 330ml · 24/cs"
          - cell "50"
          - cell "₹140.00"
        - row "Kingfisher Ultra Lager Beer 500ml Kingfisher Ultra · 500ml · 24/cs 50 ₹190.00":
          - cell "Kingfisher Ultra Lager Beer 500ml Kingfisher Ultra · 500ml · 24/cs"
          - cell "50"
          - cell "₹190.00"
        - row "Kingfisher Ultra Lager Beer 650ml Kingfisher · 650ml · 12/cs 50 ₹230.00":
          - cell "Kingfisher Ultra Lager Beer 650ml Kingfisher · 650ml · 12/cs"
          - cell "50"
          - cell "₹230.00"
        - row "Knockout High Punch Strong Beer 650ml Knockout · 650ml · 12/cs 50 ₹170.00":
          - cell "Knockout High Punch Strong Beer 650ml Knockout · 650ml · 12/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Budweiser Magnum Premium Strong Beer 330ml Budweiser Magnum Premium · 330ml · 24/cs 50 ₹150.00":
          - cell "Budweiser Magnum Premium Strong Beer 330ml Budweiser Magnum Premium · 330ml · 24/cs"
          - cell "50"
          - cell "₹150.00"
        - row "Budweiser Magnum Premium Strong Beer 500ml Budweiser · 500ml · 24/cs 50 ₹180.00":
          - cell "Budweiser Magnum Premium Strong Beer 500ml Budweiser · 500ml · 24/cs"
          - cell "50"
          - cell "₹180.00"
        - row "Budweiser Magnum Premium Strong Beer 650ml Budweiser Magnum Premium · 650ml · 12/cs 50 ₹250.00":
          - cell "Budweiser Magnum Premium Strong Beer 650ml Budweiser Magnum Premium · 650ml · 12/cs"
          - cell "50"
          - cell "₹250.00"
        - row "Tuborg Strong Export Beer 650ml Tuborg · 650ml · 12/cs 50 ₹170.00":
          - cell "Tuborg Strong Export Beer 650ml Tuborg · 650ml · 12/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Corona Extra Premium Mild Beer 330ml Corona Extra Premium · 330ml · 24/cs 50 ₹250.00":
          - cell "Corona Extra Premium Mild Beer 330ml Corona Extra Premium · 330ml · 24/cs"
          - cell "50"
          - cell "₹250.00"
        - row "Corona Extra Premium Mild Beer 500ml Corona · 500ml · 24/cs 50 ₹340.00":
          - cell "Corona Extra Premium Mild Beer 500ml Corona · 500ml · 24/cs"
          - cell "50"
          - cell "₹340.00"
        - row "Hoegaarden Belgian Witbier 330ml Hoegaarden · 330ml · 24/cs 50 ₹270.00":
          - cell "Hoegaarden Belgian Witbier 330ml Hoegaarden · 330ml · 24/cs"
          - cell "50"
          - cell "₹270.00"
        - row "Hoegaarden Belgian Witbier 500ml Hoegaarden Belgian Witbier · 500ml · 24/cs 50 ₹360.00":
          - cell "Hoegaarden Belgian Witbier 500ml Hoegaarden Belgian Witbier · 500ml · 24/cs"
          - cell "50"
          - cell "₹360.00"
        - row "Bavik Super Pils Belgian Beer 330ml Bavik · 330ml · 12/cs 50 ₹430.00":
          - cell "Bavik Super Pils Belgian Beer 330ml Bavik · 330ml · 12/cs"
          - cell "50"
          - cell "₹430.00"
        - row "Heineken Original Premium Malt Lager Beer 330ml Heineken Ori · 330ml · 24/cs 50 ₹170.00":
          - cell "Heineken Original Premium Malt Lager Beer 330ml Heineken Ori · 330ml · 24/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Heineken Original Premium Malt Lager Beer 500ml Heineken · 500ml · 24/cs 50 ₹200.00":
          - cell "Heineken Original Premium Malt Lager Beer 500ml Heineken · 500ml · 24/cs"
          - cell "50"
          - cell "₹200.00"
        - row "Carlsberg Superior All Malt Premium Beer 650ml Carlsberg · 650ml · 12/cs 50 ₹210.00":
          - cell "Carlsberg Superior All Malt Premium Beer 650ml Carlsberg · 650ml · 12/cs"
          - cell "50"
          - cell "₹210.00"
        - row "Carlsberg Elephant Super Strong Premium Beer 650ml Carlsberg · 650ml · 12/cs 50 ₹200.00":
          - cell "Carlsberg Elephant Super Strong Premium Beer 650ml Carlsberg · 650ml · 12/cs"
          - cell "50"
          - cell "₹200.00"
        - row "Kingfisher Ultra Max Premium Strong Beer 330ml Kingfisher · 330ml · 24/cs 50 ₹140.00":
          - cell "Kingfisher Ultra Max Premium Strong Beer 330ml Kingfisher · 330ml · 24/cs"
          - cell "50"
          - cell "₹140.00"
        - row "Tuborg Green Premium Lager Beer 650ml Tuborg · 650ml · 12/cs 50 ₹160.00":
          - cell "Tuborg Green Premium Lager Beer 650ml Tuborg · 650ml · 12/cs"
          - cell "50"
          - cell "₹160.00"
        - row "Heineken Lager Beer 330ml Heineken · 330ml · 24/cs 50 ₹170.00":
          - cell "Heineken Lager Beer 330ml Heineken · 330ml · 24/cs"
          - cell "50"
          - cell "₹170.00"
        - row "Heineken Lager Beer 650ml Heineken · 650ml · 12/cs 50 ₹260.00":
          - cell "Heineken Lager Beer 650ml Heineken · 650ml · 12/cs"
          - cell "50"
          - cell "₹260.00"
        - row "Black & White Blended Scotch Whisky 180ml Black & White · 180ml · 48/cs 50 ₹490.00":
          - cell "Black & White Blended Scotch Whisky 180ml Black & White · 180ml · 48/cs"
          - cell "50"
          - cell "₹490.00"
        - row "Black White Blended Scotch Whisky 375ml Black White · 375ml · 24/cs 50 ₹1050.00":
          - cell "Black White Blended Scotch Whisky 375ml Black White · 375ml · 24/cs"
          - cell "50"
          - cell "₹1050.00"
        - row "Black Dog Centenary Black Reserve Scotch Whisky 180ml Black Dog · 180ml · 48/cs 50 ₹520.00":
          - cell "Black Dog Centenary Black Reserve Scotch Whisky 180ml Black Dog · 180ml · 48/cs"
          - cell "50"
          - cell "₹520.00"
        - row "Black Dog Triple Gold Reserve Scotch Whisky 750ml Black Dog · 750ml · 12/cs 50 ₹2990.00":
          - cell "Black Dog Triple Gold Reserve Scotch Whisky 750ml Black Dog · 750ml · 12/cs"
          - cell "50"
          - cell "₹2990.00"
        - row "Seagram S Blenders Pride Res.collection Whisky 180ml Seagram S Blenders · 180ml · 48/cs 50 ₹380.00":
          - cell "Seagram S Blenders Pride Res.collection Whisky 180ml Seagram S Blenders · 180ml · 48/cs"
          - cell "50"
          - cell "₹380.00"
        - row "Seagram S Blenders Pride Res.collection Whisky 375ml Seagram S Blenders · 375ml · 24/cs 50 ₹770.00":
          - cell "Seagram S Blenders Pride Res.collection Whisky 375ml Seagram S Blenders · 375ml · 24/cs"
          - cell "50"
          - cell "₹770.00"
        - row "Blenders Pride Reserve Collection Whisky 750ml Blenders Pride · 750ml · 12/cs 50 ₹1490.00":
          - cell "Blenders Pride Reserve Collection Whisky 750ml Blenders Pride · 750ml · 12/cs"
          - cell "50"
          - cell "₹1490.00"
        - row "Absolut Vodka 200ml Absolut · 200ml · 24/cs 50 ₹710.00":
          - cell "Absolut Vodka 200ml Absolut · 200ml · 24/cs"
          - cell "50"
          - cell "₹710.00"
        - row "Jameson Irish Whiskey 200ml Jameson · 200ml · 30/cs 50 ₹770.00":
          - cell "Jameson Irish Whiskey 200ml Jameson · 200ml · 30/cs"
          - cell "50"
          - cell "₹770.00"
        - row "Johnnie Walker Red Label Blended Scotch Whisky 200ml Johnnie Walker Red · 200ml · 24/cs 50 ₹810.00":
          - cell "Johnnie Walker Red Label Blended Scotch Whisky 200ml Johnnie Walker Red · 200ml · 24/cs"
          - cell "50"
          - cell "₹810.00"
        - row "Johnnie Walker Red Label Blended Scotch Whisky 375ml Johnnie Walker · 375ml · 24/cs 50 ₹1390.00":
          - cell "Johnnie Walker Red Label Blended Scotch Whisky 375ml Johnnie Walker · 375ml · 24/cs"
          - cell "50"
          - cell "₹1390.00"
        - row "House Blend Whisky 750ml House · 750ml 6 ₹2400.00":
          - cell "House Blend Whisky 750ml House · 750ml"
          - cell "6"
          - cell "₹2400.00"
        - row "Royal Challenge American Pride Luxe Gold Whisky 180ml Royal Challenge · 180ml · 48/cs 49 ₹320.00":
          - cell "Royal Challenge American Pride Luxe Gold Whisky 180ml Royal Challenge · 180ml · 48/cs"
          - cell "49"
          - cell "₹320.00"
```

# Test source

```ts
  3   | test.describe('End-to-End Liquor Counter Application Journeys', () => {
  4   |   test.beforeEach(async ({ page }) => {
  5   |     // Listen for uncaught browser errors and console errors
  6   |     page.on('console', msg => {
  7   |       if (msg.type() === 'error') {
  8   |         console.error(`Browser console error: "${msg.text()}"`);
  9   |       }
  10  |     });
  11  |     page.on('pageerror', err => {
  12  |       console.error(`Uncaught page exception: "${err.message}"`);
  13  |     });
  14  |     await page.goto('/');
  15  |   });
  16  | 
  17  |   test('Journey 1: Public Login & Role-based authentication', async ({ page }) => {
  18  |     // 1. Verify Login Page visible
  19  |     const loginPage = page.locator('#loginPage');
  20  |     await expect(loginPage).toBeVisible();
  21  | 
  22  |     // 2. Perform Login with seeded cashier credentials
  23  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  24  |     await page.fill('#loginPass', 'Password@123');
  25  |     await page.click('button:has-text("Sign In")');
  26  | 
  27  |     // 3. Verify transition to Main App
  28  |     const mainApp = page.locator('#mainApp');
  29  |     await expect(mainApp).toBeVisible({ timeout: 10000 });
  30  | 
  31  |     // 4. Check user info display
  32  |     const userDisplay = page.locator('#userDisplay');
  33  |     await expect(userDisplay).toContainText('cashier');
  34  |   });
  35  | 
  36  |   test('Journey 2: Catalog Loading & Real Database Products', async ({ page }) => {
  37  |     // Login
  38  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  39  |     await page.fill('#loginPass', 'Password@123');
  40  |     await page.click('button:has-text("Sign In")');
  41  | 
  42  |     // Switch to POS page
  43  |     await page.click('#nav-pos');
  44  |     await expect(page.locator('#page-pos')).toBeVisible();
  45  | 
  46  |     // Check that products rendered in POS grid
  47  |     const productCards = page.locator('.pos-product');
  48  |     await expect(productCards.first()).toBeVisible({ timeout: 10000 });
  49  |     const count = await productCards.count();
  50  |     expect(count).toBeGreaterThan(0);
  51  |     console.log(`Rendered ${count} products in catalog.`);
  52  |   });
  53  | 
  54  |   test('Journey 3: POS Cart addition, pricing calculation & Checkout', async ({ page }) => {
  55  |     // Login
  56  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  57  |     await page.fill('#loginPass', 'Password@123');
  58  |     await page.click('button:has-text("Sign In")');
  59  | 
  60  |     await page.click('#nav-pos');
  61  | 
  62  |     // Add first product to cart
  63  |     const firstProduct = page.locator('.pos-product').first();
  64  |     await firstProduct.click();
  65  | 
  66  |     // Verify cart reflects addition
  67  |     const cartItems = page.locator('#cartItems');
  68  |     await expect(cartItems).not.toContainText('Add products to start billing');
  69  | 
  70  |     // Verify total is updated
  71  |     const totalAmount = page.locator('#totalAmount');
  72  |     await expect(totalAmount).toBeVisible();
  73  |     const totalText = await totalAmount.innerText();
  74  |     expect(totalText).not.toBe('₹0.00');
  75  | 
  76  |     // Click Checkout
  77  |     const checkoutBtn = page.locator('#checkoutBtn');
  78  |     await expect(checkoutBtn).toBeVisible();
  79  |     await checkoutBtn.click();
  80  | 
  81  |     // Verify Checkout Modal appears with confirmation
  82  |     const checkoutModal = page.locator('#checkoutModal');
  83  |     await expect(checkoutModal).toBeVisible({ timeout: 10000 });
  84  | 
  85  |     // Check summary text contains Bill No or confirmation
  86  |     const summary = page.locator('#checkoutSummary');
  87  |     await expect(summary).toContainText('collected via CASH');
  88  |   });
  89  | 
  90  |   test('Journey 4: Navigation across modules without JS crashes', async ({ page }) => {
  91  |     await page.fill('#loginEmail', 'cashier@liquor.com');
  92  |     await page.fill('#loginPass', 'Password@123');
  93  |     await page.click('button:has-text("Sign In")');
  94  | 
  95  |     // Cashier-level screens are reachable…
  96  |     // [menu item, id of the page it opens]
  97  |     const navTabs: Array<[string, string]> = [
  98  |       ['dashboard', 'dashboard'], ['pos', 'pos'], ['shift', 'shift'], ['bills', 'bills'], ['customers', 'customers'],
  99  |       ['tables', 'tables'], ['products', 'products'], ['inventory', 'stock'], ['counter', 'counter'],
  100 |     ];
  101 |     for (const [nav, pageId] of navTabs) {
  102 |       await page.click(`#nav-${nav}`);
> 103 |       await expect(page.locator(`#page-${pageId}`)).toBeVisible();
      |                                                     ^ Error: expect(locator).toBeVisible() failed
  104 |     }
  105 |     // …manager-only screens are not offered to a cashier
  106 |     for (const tab of ['schemes', 'compliance', 'accounting', 'closing', 'admin']) {
  107 |       await expect(page.locator(`#nav-${tab}`)).toHaveCount(0);
  108 |     }
  109 |   });
  110 | });
  111 | 
```