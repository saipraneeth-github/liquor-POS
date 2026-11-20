import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { TELANGANA_ICDC_PRODUCTS } from '../../src/db/data/telangana-products.js';
import { upsertMasterProducts } from '../../src/modules/catalog/catalog.service.js';

const FILE = join(process.cwd(), 'Testing_invoices', 'ICDCB.pdf');
let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Populate the master catalog with Telangana products (the platform operation: creates platform categories, no prices)
  await upsertMasterProducts(TELANGANA_ICDC_PRODUCTS.map((tp) => ({
    state: 'TS', categoryName: tp.category, name: tp.name, brand: tp.brand, volumeMl: tp.volumeMl,
    packQuantity: tp.packQuantity, exciseCode: tp.exciseCode, sku: tp.sku,
  })), ctx.db);
}, 120_000);

afterAll(async () => { await ctx?.app.close(); });

function multipart(content: Buffer) {
  const boundary = '----ICDC' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ICDCB.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    content, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe.skipIf(!existsSync(FILE))('New Tenant & Telangana Master Catalog Auto-Provisioning', () => {
  it('automatically provisions tenant store products from master_products and matches all lines on first upload', async () => {
    // 1. Create a brand new tenant syndicate and branch
    const [newSyndicate] = await ctx.db.insert(ctx.schema.syndicates).values({
      name: 'Telangana Fresh Syndicate',
      gstin: '36ZZZZZ9999Z1Z1',
      plan: 'STANDARD',
    }).returning();

    const [newBranch] = await ctx.db.insert(ctx.schema.branches).values({
      syndicateId: newSyndicate.id,
      name: 'Telangana Fresh Branch',
      code: 'TS-FRESH-01',
    }).returning();

    const [newManager] = await ctx.db.insert(ctx.schema.users).values({
      name: 'Fresh Manager',
      email: 'fresh.manager@test.local',
      passwordHash: 'dummy',
      role: 'manager',
      branchId: newBranch.id,
      syndicateId: newSyndicate.id,
    }).returning();

    // Verify tenant starts with 0 products
    const initialProducts = await ctx.db.select().from(ctx.schema.products)
      .where(eq(ctx.schema.products.syndicateId, newSyndicate.id));
    expect(initialProducts.length).toBe(0);

    // 2. Upload ICDC invoice against this new branch using the new tenant's manager
    const mp = multipart(readFileSync(FILE));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${newBranch.id}/upload`,
      headers: {
        ...ctx.authFor({
          sub: newManager.id,
          email: newManager.email,
          role: 'manager',
          branchId: newBranch.id,
          syndicateId: newSyndicate.id,
        }),
        'content-type': mp.contentType,
      },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(201);
    const uploaded = res.json();

    // Verify all 30 lines are MATCHED directly!
    expect(uploaded.items).toHaveLength(30);
    for (const it of uploaded.items) {
      expect(it.matchStatus, `line ${it.lineNumber}`).toBe('MATCHED');
      expect(it.productId).toBeTruthy();
    }

    // Verify products were created in the products table linked to master_products
    const tenantProducts = await ctx.db.select().from(ctx.schema.products)
      .where(eq(ctx.schema.products.syndicateId, newSyndicate.id));
    expect(tenantProducts.length).toBeGreaterThan(0);
    for (const tp of tenantProducts) {
      expect(tp.masterProductId).toBeTruthy();
    }
  });

  it('blocks billing for items with 0.00 MRP until a retail selling price is set', async () => {
    // 1. Create product with 0.00 MRP (simulating store item before retail price configuration)
    const [cat] = await ctx.db.select().from(ctx.schema.categories).limit(1);
    const [zeroMrpProd] = await ctx.db.insert(ctx.schema.products).values({
      categoryId: cat.id,
      name: 'Unpriced Special Whisky 750ml',
      brand: 'Special',
      mrp: '0.00',
      syndicateId: ctx.syndicateId,
    }).returning();

    // Add stock so stock check passes
    await ctx.db.insert(ctx.schema.stock).values({
      branchId: ctx.branchId,
      productId: zeroMrpProd.id,
      quantity: 50,
    });

    // 2. Attempt to create a bill for this unpriced item
    const billRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/bills',
      headers: ctx.auth('cashier'),
      payload: {
        branchId: ctx.branchId,
        items: [{ productId: zeroMrpProd.id, quantity: 1 }],
        paymentMode: 'CASH',
        clientRef: 'test-zero-mrp-guard-' + Date.now(),
      },
    });

    // Expect 422 BusinessRuleError
    expect(billRes.statusCode).toBe(422);
    expect(billRes.json().error).toMatch(/MRP ₹0\.00|no selling price set/i);

    // 3. Update the MRP via manager
    const updateRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${zeroMrpProd.id}/mrp`,
      headers: ctx.auth('manager'),
      payload: { mrp: '950.00' },
    });
    expect(updateRes.statusCode).toBe(200);

    // 4. Billing should now succeed
    const validBillRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/bills',
      headers: ctx.auth('cashier'),
      payload: {
        branchId: ctx.branchId,
        items: [{ productId: zeroMrpProd.id, quantity: 1 }],
        paymentMode: 'CASH',
        clientRef: 'test-priced-mrp-' + Date.now(),
      },
    });
    expect(validBillRes.statusCode).toBe(201);
  });

  it('master products lookup endpoint returns accurate Telangana product details', async () => {
    // Test brand code 5028 (Haywards 5000 Super Strong Beer 650ml)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/master-products/lookup?exciseCode=5028&volumeMl=650',
      headers: ctx.auth('cashier'),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.name).toBe('Haywards 5000 Super Strong Beer 650ml');
    expect(data.brand).toBe('Haywards 5000');
    expect(data.volumeMl).toBe(650);
    expect(data.packQuantity).toBe(12);
    expect(data.exciseCode).toBe('5028');
  });

  it('PATCH /products/:id updates and sanitizes product name', async () => {
    const [cat] = await ctx.db.select().from(ctx.schema.categories).limit(1);
    const [prod] = await ctx.db.insert(ctx.schema.products).values({
      categoryId: cat.id,
      name: 'Old Dirty Name [29 cs + 10 btls]',
      brand: 'Test',
      mrp: '200.00',
      syndicateId: ctx.syndicateId,
    }).returning();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${prod.id}`,
      headers: ctx.auth('cashier'),
      payload: {
        name: 'Budweiser King of Beers [29 cs + 10 btls] 650ml',
      },
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    // Case/bottle notation must be cleanly stripped!
    expect(updated.name).toBe('Budweiser King of Beers 650ml');
  });
});
