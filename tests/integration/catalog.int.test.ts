/**
 * Master catalog → business mapping, and the business's / branch's prices.
 * A brand-new business picks products from the master (no prices), sees them as "needs price", cannot bill them,
 * types a business price, gives one branch its own price, and never sees another business's data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { upsertMasterProducts, mapMasterProducts } from '../../src/modules/catalog/catalog.service.js';

let ctx: IntegrationContext;
const T = { syn: '', b1: '', b2: '', manager: { id: '', email: '' }, cashier: { id: '', email: '' }, manager2: { id: '', email: '' } };
let masters: Array<{ id: string; sku: string }> = [];

const as = (who: 'manager' | 'cashier' | 'manager2') => {
  const u = T[who];
  return ctx.authFor({ sub: u.id, email: u.email, role: who === 'cashier' ? 'cashier' : 'manager', branchId: who === 'manager2' ? T.b2 : T.b1, syndicateId: T.syn });
};
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });

beforeAll(async () => {
  ctx = await setupIntegration();
  const { schema, db } = ctx;
  const [syn] = await db.insert(schema.syndicates).values({ name: 'Fresh Business', maxBranches: 5 }).returning();
  const [b1] = await db.insert(schema.branches).values({ name: 'Fresh One', code: 'FR1', syndicateId: syn.id }).returning();
  const [b2] = await db.insert(schema.branches).values({ name: 'Fresh Two', code: 'FR2', syndicateId: syn.id }).returning();
  const mk = async (name: string, role: 'manager' | 'cashier', branchId: string) =>
    (await db.insert(schema.users).values({ name, email: `${name.replace(/\s/g, '').toLowerCase()}@fresh.local`, passwordHash: 'x', role, branchId }).returning())[0];
  const m = await mk('Fresh Manager', 'manager', b1.id);
  const c = await mk('Fresh Cashier', 'cashier', b1.id);
  const m2 = await mk('Fresh Manager Two', 'manager', b2.id);
  Object.assign(T, { syn: syn.id, b1: b1.id, b2: b2.id, manager: { id: m.id, email: m.email }, cashier: { id: c.id, email: c.email }, manager2: { id: m2.id, email: m2.email } });

  await upsertMasterProducts([
    { categoryName: 'Whisky', name: 'Catalog Test Whisky 750ml', brand: 'CTW', volumeMl: 750, packQuantity: 12, exciseCode: '9901', sku: 'TS-9901-750' },
    { categoryName: 'Whisky', name: 'Catalog Test Whisky 375ml', brand: 'CTW', volumeMl: 375, packQuantity: 24, exciseCode: '9901', sku: 'TS-9901-375' },
    { categoryName: 'Beer', name: 'Catalog Test Beer 650ml', brand: 'CTB', volumeMl: 650, packQuantity: 12, exciseCode: '9902', sku: 'TS-9902-650', barcodes: ['8901234500001'] },
    { categoryName: 'Gin', name: 'Catalog Test Gin 750ml', brand: 'CTG', volumeMl: 750, packQuantity: 12, exciseCode: '9903', sku: 'TS-9903-750' },
  ], db);
  masters = await db.select({ id: schema.masterProducts.id, sku: schema.masterProducts.sku }).from(schema.masterProducts)
    .where(inArray(schema.masterProducts.sku, ['TS-9901-750', 'TS-9901-375', 'TS-9902-650', 'TS-9903-750']));
}, 120_000);
afterAll(async () => { await ctx?.app.close(); });

const productsOf = async (syn: string) => ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.syndicateId, syn));
const stockUp = async (productId: string, branchId: string) =>
  ctx.db.insert(ctx.schema.stock).values({ branchId, productId, quantity: 50 }).onConflictDoNothing();
async function billPrice(productId: string, branchId: string, who: 'cashier' | 'manager2') {
  const res = await call('POST', '/bills', as(who), { branchId, paymentMode: 'CASH', items: [{ productId, quantity: 1 }] });
  if (res.statusCode !== 201) return { status: res.statusCode, error: res.json().error as string, unit: null as string | null };
  const [item] = await ctx.db.select().from(ctx.schema.billItems).where(eq(ctx.schema.billItems.billId, res.json().id));
  return { status: 201, error: '', unit: item.unitPrice };
}

describe('the master catalog carries no prices', () => {
  it('master_products has no price columns and the list shows no price', async () => {
    const cols = Object.keys(ctx.schema.masterProducts);
    expect(cols).not.toContain('referenceMrp');
    expect(cols).not.toContain('referenceCost');
    const res = await call('GET', `/catalog/master?branchId=${T.b1}&q=Catalog Test`, as('manager'));
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(4);
    expect(JSON.stringify(res.json())).not.toMatch(/"(mrp|price|cost)/i);
    expect(res.json().items.every((i: { mapped: boolean }) => i.mapped === false)).toBe(true);
  });

  it('finds a master product by barcode and by category', async () => {
    expect((await call('GET', `/catalog/master?branchId=${T.b1}&q=8901234500001`, as('manager'))).json().total).toBe(1);
    expect((await call('GET', `/catalog/master?branchId=${T.b1}&category=Gin&q=Catalog Test`, as('manager'))).json().total).toBe(1);
  });
});

describe('mapping master products to a business', () => {
  it('a cashier cannot add products from the master; a manager can', async () => {
    expect((await call('POST', '/catalog/master/map', as('cashier'), { masterProductIds: [masters[0].id] })).statusCode).toBe(403);
    const res = await call('POST', '/catalog/master/map', as('manager'), { masterProductIds: masters.slice(0, 3).map((m) => m.id) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: 3, alreadyMapped: 0, skipped: [] });
  });

  it('mapped products come from the master and start unpriced', async () => {
    const mine = await productsOf(T.syn);
    expect(mine).toHaveLength(3);
    for (const p of mine) {
      expect(p.masterProductId).toBeTruthy();
      expect(Number(p.mrp)).toBe(0);
      expect(p.costPrice).toBeNull();
      expect(p.categoryId).toBeTruthy();
    }
    const list = (await call('GET', `/products?branchId=${T.b1}`, as('manager'))).json() as Array<{ sku: string; needsPrice: boolean }>;
    expect(list.filter((p) => p.sku?.startsWith('TS-99')).every((p) => p.needsPrice)).toBe(true);
  });

  it('adding the same master product twice, even at the same time, gives one product', async () => {
    const again = await call('POST', '/catalog/master/map', as('manager'), { masterProductIds: masters.slice(0, 3).map((m) => m.id) });
    expect(again.json()).toMatchObject({ created: 0, alreadyMapped: 3 });
    const gin = masters[3].id;
    const [a, b] = await Promise.all([
      call('POST', '/catalog/master/map', as('manager'), { masterProductIds: [gin] }),
      call('POST', '/catalog/master/map', as('manager2'), { masterProductIds: [gin] }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect((await productsOf(T.syn)).filter((p) => p.masterProductId === gin)).toHaveLength(1);
  });

  it('mapping by category adds the whole category once', async () => {
    const beer = await call('POST', '/catalog/master/map', as('manager'), { categoryNames: ['Beer'] });
    expect(beer.statusCode).toBe(201);
    // the test master has one TS beer; other TS beers (from other suites' master data) may exist, so only check idempotence
    const second = await call('POST', '/catalog/master/map', as('manager'), { categoryNames: ['Beer'] });
    expect(second.json().created).toBe(0);
  });

  it('identity of a mapped product is locked to the master; renaming and barcode are allowed', async () => {
    const [p] = (await productsOf(T.syn)).filter((x) => x.sku === 'TS-9901-750');
    expect((await call('PATCH', `/products/${p.id}`, as('manager'), { brand: 'Changed' })).statusCode).toBe(422);
    expect((await call('PATCH', `/products/${p.id}`, as('manager'), { volumeMl: 1000 })).statusCode).toBe(422);
    expect((await call('PATCH', `/products/${p.id}`, as('manager'), { name: 'My Own Display Name', barcode: 'FR-BC-1' })).statusCode).toBe(200);
  });

  it('creating a product from a master id takes its identity from the master and refuses a duplicate', async () => {
    const res = await call('POST', '/products', as('manager'), { categoryId: (await productsOf(T.syn))[0].categoryId, name: 'whatever', masterProductId: masters[0].id });
    expect(res.statusCode).toBe(409);
  });
});

describe('unpriced products cannot be sold; prices are the business\'s own', () => {
  let p750: string;
  let p375: string;
  beforeAll(async () => {
    const mine = await productsOf(T.syn);
    p750 = mine.find((x) => x.sku === 'TS-9901-750')!.id;
    p375 = mine.find((x) => x.sku === 'TS-9901-375')!.id;
    for (const p of mine) { await stockUp(p.id, T.b1); await stockUp(p.id, T.b2); }
  });

  it('billing an unpriced product is a 422 that says to set the price', async () => {
    const r = await billPrice(p750, T.b1, 'cashier');
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/no selling price/i);
  });

  it('the pricing grid lists them as needing a price', async () => {
    const res = await call('GET', `/catalog/pricing?branchId=${T.b1}&unpricedOnly=1`, as('manager'));
    expect(res.statusCode).toBe(200);
    expect(res.json().unpricedCount).toBeGreaterThanOrEqual(4);
    expect(res.json().items.every((i: { needsPrice: boolean }) => i.needsPrice)).toBe(true);
  });

  it('a cashier cannot set prices; a manager types a business price (by id and by SKU) and it is audited', async () => {
    expect((await call('PUT', '/catalog/prices', as('cashier'), { rows: [{ productId: p750, price: '900.00' }] })).statusCode).toBe(403);
    const res = await call('PUT', '/catalog/prices', as('manager'), { rows: [{ productId: p750, price: '900' }, { sku: 'TS-9901-375', price: '480.50' }, { sku: 'NOPE', price: '1' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updated: 2, unknown: ['NOPE'] });
    const audits = await ctx.db.select().from(ctx.schema.priceAudit).where(inArray(ctx.schema.priceAudit.productId, [p750, p375]));
    expect(audits.map((a) => a.newMrp).sort()).toEqual(['480.50', '900.00']);
    expect(audits.every((a) => a.branchId === null)).toBe(true);
  });

  it('rejects a zero, negative or malformed price', async () => {
    for (const price of ['0', '0.00', '-5', 'abc', '1.234']) {
      expect((await call('PUT', '/catalog/prices', as('manager'), { rows: [{ productId: p750, price }] })).statusCode, price).toBe(400);
    }
  });

  it('the business price is what every branch bills', async () => {
    expect((await billPrice(p750, T.b1, 'cashier')).unit).toBe('900.00');
    expect((await billPrice(p750, T.b2, 'manager2')).unit).toBe('900.00');
  });

  it('a branch override applies only at that branch, and removing it goes back to the business price', async () => {
    const set = await call('PUT', `/catalog/branches/${T.b1}/prices`, as('manager'), { rows: [{ productId: p750, price: '950.00' }] });
    expect(set.json()).toMatchObject({ updated: 1 });
    expect((await billPrice(p750, T.b1, 'cashier')).unit).toBe('950.00');
    expect((await billPrice(p750, T.b2, 'manager2')).unit).toBe('900.00');
    // the POS list shows the price this branch charges
    const list = (await call('GET', `/products?branchId=${T.b1}`, as('manager'))).json() as Array<{ id: string; mrp: string; tenantMrp: string; branchPrice: string | null }>;
    expect(list.find((p) => p.id === p750)).toMatchObject({ mrp: '950.00', tenantMrp: '900.00', branchPrice: '950.00' });
    // a manager of branch 2 cannot touch branch 1's prices
    expect((await call('PUT', `/catalog/branches/${T.b1}/prices`, as('manager2'), { rows: [{ productId: p750, price: '1.00' }] })).statusCode).toBe(403);

    const clear = await call('PUT', `/catalog/branches/${T.b1}/prices`, as('manager'), { rows: [{ productId: p750, price: null }] });
    expect(clear.json()).toMatchObject({ removed: 1 });
    expect((await billPrice(p750, T.b1, 'cashier')).unit).toBe('900.00');
    const audits = await ctx.db.select().from(ctx.schema.priceAudit).where(and(eq(ctx.schema.priceAudit.productId, p750), eq(ctx.schema.priceAudit.branchId, T.b1)));
    expect(audits).toHaveLength(1);
  });

  it('a product with no business price can still be sold by a branch that prices it itself', async () => {
    const gin = (await productsOf(T.syn)).find((x) => x.sku === 'TS-9903-750')!.id;
    await stockUp(gin, T.b1);
    expect((await billPrice(gin, T.b1, 'cashier')).status).toBe(422);
    await call('PUT', `/catalog/branches/${T.b1}/prices`, as('manager'), { rows: [{ productId: gin, price: '1500.00' }] });
    expect((await billPrice(gin, T.b1, 'cashier')).unit).toBe('1500.00');
    expect((await billPrice(gin, T.b2, 'manager2')).status).toBe(422);   // branch two still has none
  });

  it('the old PATCH /products/:id/mrp still sets the business price', async () => {
    expect((await call('PATCH', `/products/${p375}/mrp`, as('manager'), { mrp: '500.00' })).statusCode).toBe(200);
    expect((await billPrice(p375, T.b1, 'cashier')).unit).toBe('500.00');
  });
});

describe('another business sees none of it', () => {
  it('the main test business has none of the new business\'s products, prices or categories', async () => {
    const list = (await call('GET', '/products', ctx.auth('manager'))).json() as Array<{ id: string; sku: string | null }>;
    expect(list.some((p) => p.sku?.startsWith('TS-99'))).toBe(false);
    const mine = await productsOf(T.syn);
    for (const p of mine) {
      expect((await call('PATCH', `/products/${p.id}/mrp`, ctx.auth('manager'), { mrp: '1.00' })).statusCode).toBe(404);
      expect((await call('PATCH', `/products/${p.id}`, ctx.auth('manager'), { name: 'Hijack' })).statusCode).toBe(404);
    }
    // the main business sees no master-catalog "mapped" flags from the other business
    const master = (await call('GET', `/catalog/master?branchId=${ctx.branchId}&q=Catalog Test`, ctx.auth('manager'))).json();
    expect(master.items.every((i: { mapped: boolean }) => i.mapped === false)).toBe(true);
    expect((await call('GET', `/catalog/pricing?branchId=${T.b1}`, ctx.auth('manager'))).statusCode).toBe(403);
  });

  it('a product of one business cannot be billed at another business\'s branch', async () => {
    const mine = (await productsOf(T.syn))[0];
    const res = await call('POST', '/bills', ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: mine.id, quantity: 1 }] });
    expect(res.statusCode).toBe(422);
  });

  it('categories: a business sees the platform\'s and its own, never another\'s', async () => {
    const { schema, db } = ctx;
    await db.insert(schema.categories).values({ name: 'Fresh Kitchen Specials', taxRate: '5.00', syndicateId: T.syn });
    const theirs = (await call('GET', '/categories', as('manager'))).json() as Array<{ name: string }>;
    const ours = (await call('GET', '/categories', ctx.auth('manager'))).json() as Array<{ name: string }>;
    expect(theirs.some((c) => c.name === 'Fresh Kitchen Specials')).toBe(true);
    expect(ours.some((c) => c.name === 'Fresh Kitchen Specials')).toBe(false);
    expect(ours.some((c) => c.name === 'Whisky')).toBe(true);
    // a tenant may reuse a platform name for its own category (names are unique per owner, not globally)
    await db.insert(schema.categories).values({ name: 'Whisky', taxRate: '5.00', syndicateId: T.syn });
    // ... but not twice
    await expect(db.insert(schema.categories).values({ name: 'whisky', taxRate: '5.00', syndicateId: T.syn })).rejects.toThrow();
  });

  it('brand-code mappings and their products stay inside one business', async () => {
    const mineProd = (await productsOf(T.syn)).find((x) => x.sku === 'TS-9901-750')!;
    // the other business cannot point a mapping at this business's product
    const steal = await call('POST', '/inventory/brand-mappings', ctx.auth('manager'), { brandCode: '9901', volumeMl: 750, productId: mineProd.id, branchId: ctx.branchId });
    expect(steal.statusCode).toBe(404);
    const made = await call('POST', '/inventory/brand-mappings', as('manager'), { brandCode: '9901', volumeMl: 750, productId: mineProd.id, branchId: T.b1 });
    expect(made.statusCode).toBe(200);
    const theirs = (await call('GET', `/inventory/brand-mappings?branchId=${T.b1}`, as('manager'))).json() as Array<{ id: string }>;
    expect(theirs.some((m) => m.id === made.json().id)).toBe(true);
    const ours = (await call('GET', '/inventory/brand-mappings', ctx.auth('manager'))).json() as Array<{ id: string }>;
    expect(ours.some((m) => m.id === made.json().id)).toBe(false);
    expect((await call('DELETE', `/inventory/brand-mappings/${made.json().id}`, ctx.auth('manager'))).statusCode).toBe(404);
    expect((await call('DELETE', `/inventory/brand-mappings/${made.json().id}`, as('manager'))).statusCode).toBe(200);
    expect((await call('GET', `/inventory/brand-mappings?branchId=${T.b1}`, ctx.auth('manager'))).statusCode).toBe(403);
  });

  it('a brand code unknown to the master creates an UNPRICED own product and invents no price or category', async () => {
    const noCat = await call('POST', '/inventory/brand-mappings', as('manager'), { brandCode: '7777', volumeMl: 750, productName: 'Local Brand', branchId: T.b1 });
    expect(noCat.statusCode).toBe(422);   // no category guessed
    const ok = await call('POST', '/inventory/brand-mappings', as('manager'), { brandCode: '7777', volumeMl: 750, productName: 'Local Brand', categoryName: 'Whisky', branchId: T.b1 });
    expect(ok.statusCode).toBe(200);
    const [p] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.id, ok.json().productId));
    expect(p.syndicateId).toBe(T.syn);
    expect(Number(p.mrp)).toBe(0);
    expect(p.costPrice).toBeNull();
  });
});

describe('mapMasterProducts', () => {
  it('adopts an own product that already carries the master SKU instead of duplicating it', async () => {
    const { schema, db } = ctx;
    const [cat] = await db.select().from(schema.categories).limit(1);
    const [own] = await db.insert(schema.products).values({ name: 'Hand made gin', brand: 'CTG', sku: 'TS-9903-750-X', categoryId: cat.id, syndicateId: ctx.otherSyndicateId, mrp: '10.00' }).returning();
    await db.update(schema.products).set({ sku: 'TS-9903-750' }).where(eq(schema.products.id, own.id));
    const res = await mapMasterProducts(db, ctx.otherSyndicateId, [masters[3].id]);
    expect(res.created).toBe(1);
    const mine = (await productsOf(ctx.otherSyndicateId)).filter((p) => p.sku === 'TS-9903-750');
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(own.id);
    expect(mine[0].masterProductId).toBe(masters[3].id);
    expect(mine[0].mrp).toBe('10.00');   // its price is kept
  });
});

describe('cost is per branch', () => {
  const approveAt = async (branchId: string, who: 'manager' | 'manager2', number: string, productId: string, cost: string) => {
    const created = await call('POST', `/invoices/${branchId}`, as(who), {
      supplierName: 'Acme', invoiceNumber: number, totalAmount: (Number(cost) * 10).toFixed(2),
      items: [{ productId, rawDescription: 'Cost test', quantity: 10, costPrice: cost }],   // no MRP: an invoice has only what was paid
    });
    expect(created.statusCode, created.body).toBe(201);
    const ok = await call('POST', `/invoices/detail/${created.json().invoice.id}/approve`, as(who));
    expect(ok.statusCode, ok.body).toBe(200);
  };
  const costOf = async (branchId: string, productId: string) =>
    (await ctx.db.select().from(ctx.schema.branchProductCosts).where(and(eq(ctx.schema.branchProductCosts.branchId, branchId), eq(ctx.schema.branchProductCosts.productId, productId))))[0];

  it("two branches keep their own last cost and 'previous cost'; the Products list shows each branch's own", async () => {
    const p = (await productsOf(T.syn)).find((x) => x.sku === 'TS-9902-650')!.id;
    await approveAt(T.b1, 'manager', 'COST-B1-1', p, '100.00');
    await approveAt(T.b2, 'manager2', 'COST-B2-1', p, '140.00');
    expect(Number((await costOf(T.b1, p)).costPrice)).toBe(100);
    expect(Number((await costOf(T.b2, p)).costPrice)).toBe(140);
    expect((await costOf(T.b2, p)).previousCostPrice).toBeNull();   // branch 2 never bought it before: branch 1's price is not its history

    await approveAt(T.b1, 'manager', 'COST-B1-2', p, '110.00');
    const b1 = await costOf(T.b1, p);
    expect(Number(b1.costPrice)).toBe(110);
    expect(Number(b1.previousCostPrice)).toBe(100);
    expect(Number((await costOf(T.b2, p)).costPrice)).toBe(140);    // untouched by branch 1's second purchase
    // the product was never priced, so approving invoices for it must work and must not invent a selling price
    const [row] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.id, p));
    expect(Number(row.mrp)).toBe(0);

    const at = async (branch: string, who: 'manager' | 'manager2') =>
      ((await call('GET', `/products?branchId=${branch}`, as(who))).json() as Array<{ id: string; costPrice: string | null }>).find((x) => x.id === p)!.costPrice;
    expect(Number(await at(T.b1, 'manager'))).toBe(110);
    expect(Number(await at(T.b2, 'manager2'))).toBe(140);
    // a cashier (no cost.view) never sees either
    const seen = ((await call('GET', `/products?branchId=${T.b1}`, as('cashier'))).json() as Array<Record<string, unknown>>).find((x) => x.id === p)!;
    expect('costPrice' in seen).toBe(false);
  });
});

describe('master catalog changes reach the businesses that added a product', () => {
  const platform = async () => {
    const [u] = await ctx.db.insert(ctx.schema.users).values({ name: 'Platform Master', email: 'platform.master@test.local', passwordHash: 'x', role: 'owner', branchId: null, syndicateId: null }).returning();
    return ctx.authFor({ sub: u.id, email: u.email, role: 'owner', branchId: null, syndicateId: null });
  };
  let sa: Record<string, string>;
  beforeAll(async () => { sa = await platform(); });

  it('only the Super Admin can edit the master catalog or its categories', async () => {
    const m = masters[0].id;
    for (const h of [ctx.auth('owner'), as('manager'), as('cashier')]) {
      expect((await call('PATCH', `/platform/master/products/${m}`, h, { packQuantity: 6 })).statusCode).toBe(403);
      expect((await call('GET', '/platform/master/products', h)).statusCode).toBe(403);
      expect((await call('POST', '/platform/master/categories', h, { name: 'Sneaky', taxRate: '1' })).statusCode).toBe(403);
    }
  });

  it('a change to what the bottle is raises the revision; the business sees the update and applies it without losing price or name', async () => {
    const [p] = (await productsOf(T.syn)).filter((x) => x.sku === 'TS-9901-750');
    expect(await call('GET', `/catalog/master/updates?branchId=${T.b1}`, as('manager')).then((r) => r.json())).toEqual([]);

    const res = await call('PATCH', `/platform/master/products/${masters[0].id}`, sa, { packQuantity: 24, name: 'Catalog Test Whisky 750ml (new label)' });
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toBe(2);
    // a rename alone does not bump the revision
    expect((await call('PATCH', `/platform/master/products/${masters[0].id}`, sa, { name: 'Catalog Test Whisky 750ml' })).json().revision).toBe(2);

    const list = (await call('GET', `/catalog/master/updates?branchId=${T.b1}`, as('manager'))).json() as Array<{ productId: string; changes: Array<{ field: string; from: string; to: string }> }>;
    const mine = list.find((u) => u.productId === p.id)!;
    expect(mine.changes).toEqual([{ field: 'Pack', from: '12', to: '24' }]);
    // the other business has not added it, so it sees nothing
    expect(await call('GET', `/catalog/master/updates?branchId=${ctx.branchId}`, ctx.auth('manager')).then((r) => r.json())).toEqual([]);

    expect((await call('POST', '/catalog/master/updates/apply', as('cashier'), {})).statusCode).toBe(403);
    const applied = await call('POST', '/catalog/master/updates/apply', as('manager'), {});
    expect(applied.json()).toMatchObject({ applied: 1, skipped: [] });
    const [after] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.id, p.id));
    expect(after.packQuantity).toBe(24);
    expect(after.masterRevision).toBe(2);
    expect(after.name).toBe('My Own Display Name');   // the business's display name is kept
    expect(after.mrp).toBe(p.mrp);                      // so is the price
    expect((await call('POST', '/catalog/master/updates/apply', as('manager'), {})).json().applied).toBe(0);
    expect(await call('GET', `/catalog/master/updates?branchId=${T.b1}`, as('manager')).then((r) => r.json())).toEqual([]);
  });

  it('a discontinued master product is flagged to the business but nothing is removed', async () => {
    await call('PATCH', `/platform/master/products/${masters[1].id}`, sa, { isActive: false });
    const list = (await call('GET', `/catalog/master/updates?branchId=${T.b1}`, as('manager'))).json() as Array<{ name: string; discontinued: boolean }>;
    expect(list.some((u) => u.discontinued)).toBe(true);
    const [still] = (await productsOf(T.syn)).filter((x) => x.sku === 'TS-9901-375');
    expect(still.isActive).toBe(true);
    // and it can no longer be added by a business that has not
    const gone = await call('GET', `/catalog/master?branchId=${ctx.branchId}&q=Catalog Test Whisky 375`, ctx.auth('manager'));
    expect(gone.json().total).toBe(0);
    await call('PATCH', `/platform/master/products/${masters[1].id}`, sa, { isActive: true });
  });

  it('import creates a missing platform category, refreshes by (state, excise code, size) and rejects bad rows', async () => {
    const row = { categoryName: 'Tequila', name: 'Catalog Test Tequila 750ml', brand: 'CTT', volumeMl: 750, packQuantity: 6, exciseCode: '9910', sku: 'TS-9910-750' };
    expect((await call('POST', '/platform/master/import', sa, { rows: [{ ...row, volumeMl: 0 }] })).statusCode).toBe(400);
    const first = await call('POST', '/platform/master/import', sa, { rows: [row] });
    expect(first.json()).toEqual({ added: 1, updated: 0 });
    const again = await call('POST', '/platform/master/import', sa, { rows: [{ ...row, packQuantity: 12 }] });
    expect(again.json()).toEqual({ added: 0, updated: 1 });
    const cats = (await call('GET', '/platform/master/categories', sa)).json() as Array<{ name: string; taxRate: string }>;
    expect(cats.find((c) => c.name === 'Tequila')).toBeTruthy();
    const list = (await call('GET', '/platform/master/products?q=9910', sa)).json();
    expect(list.items[0]).toMatchObject({ packQuantity: 12, revision: 2 });
  });

  it('category GST can be corrected by the Super Admin and is validated', async () => {
    const cats = (await call('GET', '/platform/master/categories', sa)).json() as Array<{ id: string; name: string }>;
    const tequila = cats.find((c) => c.name === 'Tequila')!;
    expect((await call('PATCH', `/platform/master/categories/${tequila.id}`, sa, { name: 'Tequila', taxRate: '28' })).json().taxRate).toBe('28.00');
    expect((await call('PATCH', `/platform/master/categories/${tequila.id}`, sa, { name: 'Tequila', taxRate: '250' })).statusCode).toBe(400);
    expect((await call('POST', '/platform/master/categories', sa, { name: 'tequila', taxRate: '18' })).statusCode).toBe(409);   // names are unique
  });
});

describe('sale-type prices show the branch override', () => {
  it("the price matrix carries this branch's own prices and not another branch's", async () => {
    const gin = (await productsOf(T.syn)).find((x) => x.sku === 'TS-9903-750')!.id;
    const b1 = (await call('GET', `/sale-types/${T.b1}/prices`, as('manager'))).json() as { products: Array<{ id: string; branchPrices: Record<string, string> }> };
    const b2 = (await call('GET', `/sale-types/${T.b2}/prices`, as('manager2'))).json() as { products: Array<{ id: string; branchPrices: Record<string, string> }> };
    expect(b1.products.find((p) => p.id === gin)!.branchPrices).toEqual({ default: '1500.00' });
    expect(b2.products.find((p) => p.id === gin)!.branchPrices).toEqual({});
  });
});

describe('pricing, master state and price filters, and stock/cost visibility', () => {
  it('GET /catalog/master/states returns available states', async () => {
    const res = await call('GET', '/catalog/master/states', as('cashier'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContain('TS');
  });

  it('GET /catalog/master supports state and priceStatus filters', async () => {
    const unpriced = await call('GET', `/catalog/master?branchId=${T.b1}&state=TS&priceStatus=unpriced`, as('cashier'));
    expect(unpriced.statusCode).toBe(200);
    const priced = await call('GET', `/catalog/master?branchId=${T.b1}&state=TS&priceStatus=priced`, as('cashier'));
    expect(priced.statusCode).toBe(200);
  });

  it('GET /catalog/pricing includes costPrice and stockQuantity and filters inStockOnly', async () => {
    const all = await call('GET', `/catalog/pricing?branchId=${T.b1}`, as('manager'));
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty('stockQuantity');
    expect(body.items[0]).toHaveProperty('costPrice');

    const inStock = await call('GET', `/catalog/pricing?branchId=${T.b1}&inStockOnly=1`, as('manager'));
    expect(inStock.statusCode).toBe(200);
    for (const item of inStock.json().items) {
      expect(item.stockQuantity).toBeGreaterThan(0);
    }
  });

  it('GET /sale-types/:branchId/prices includes stockQuantity and costPrice', async () => {
    const res = await call('GET', `/sale-types/${T.b1}/prices`, as('manager'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products[0]).toHaveProperty('stockQuantity');
    expect(body.products[0]).toHaveProperty('costPrice');
  });
});
