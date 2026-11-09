/**
 * Permissions: roles give the defaults, a manager / office admin / owner can switch single actions on or off per user and
 * limit a cashier to some sale types. Cashiers never see cost, discounts are capped at 5%, an office admin can do everything a
 * business owner does inside the business but cannot mint other office admins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'owner' | 'manager' | 'office_admin' | 'cashier' | 'steward';
const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });
const perms = (userId: string, role: Role, body: unknown) => inject('PUT', `/users/${userId}/permissions`, role, body);
const bill = (role: Role, discount: string, saleTypeId?: string) =>
  inject('POST', '/bills', role, { branchId: ctx.branchId, paymentMode: 'CASH', discount, items: [{ productId: ctx.products[0].id, quantity: 1 }], ...(saleTypeId ? { saleTypeId } : {}) });

describe('cost prices are hidden from anyone without cost.view', () => {
  it('cashier and steward never see cost; manager does', async () => {
    for (const role of ['cashier', 'steward'] as const) {
      const list = (await inject('GET', `/products?branchId=${ctx.branchId}`, role)).json() as Record<string, unknown>[];
      expect(list[0]).toHaveProperty('mrp');
      expect(list[0]).not.toHaveProperty('costPrice');
      expect(list[0]).not.toHaveProperty('lastInvoiceNumber');
    }
    const byBarcode = (await inject('GET', '/products/barcode/1000000000001', 'cashier')).json();
    expect(byBarcode).not.toHaveProperty('costPrice');
    const stock = (await inject('GET', `/inventory/stock/${ctx.branchId}`, 'cashier')).json() as Record<string, unknown>[];
    expect(stock[0]).not.toHaveProperty('costPrice');
    expect(stock[0]).not.toHaveProperty('costPerCase');
    expect(((await inject('GET', `/products`, 'manager')).json() as Record<string, unknown>[])[0]).toHaveProperty('costPrice');
    expect(((await inject('GET', `/inventory/stock/${ctx.branchId}`, 'manager')).json() as Record<string, unknown>[])[0]).toHaveProperty('costPrice');
  });

  it('supplier invoices (all cost) are closed to a cashier, with a clear code', async () => {
    for (const [method, url] of [['GET', `/invoices/${ctx.branchId}`], ['POST', `/invoices/${ctx.branchId}`], ['GET', `/invoices/${ctx.branchId}/check-duplicate?invoiceNumber=X`]] as const) {
      const res = await inject(method, url, 'cashier', method === 'POST' ? {} : undefined);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cost.view' });
    }
    expect((await inject('GET', `/invoices/${ctx.branchId}`, 'manager')).statusCode).toBe(200);
  });

  it('breakage keeps its cost value to people who may see cost', async () => {
    const res = await inject('POST', `/compliance/breakage/${ctx.branchId}`, 'cashier', { productId: ctx.products[1].id, quantity: 1, reason: 'Dropped in the aisle' });
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.stringify(res.json())).not.toMatch(/costValue/);               // nowhere in the response, at any depth
    const mgr = await inject('POST', `/compliance/breakage/${ctx.branchId}`, 'manager', { productId: ctx.products[1].id, quantity: 1, reason: 'Dropped in the aisle' });
    expect(mgr.json().breakage).toHaveProperty('costValue');
  });
});

describe('discounts are capped at 5% unless allowed', () => {
  it('a cashier gets 5% exactly but not a paisa more; a manager is not capped', async () => {
    expect((await bill('cashier', '50.00')).statusCode).toBe(201);            // 5% of ₹1000.00
    const over = await bill('cashier', '50.01');
    expect(over.statusCode).toBe(422);
    expect(over.body).toMatch(/above 5%/);
    expect((await bill('manager', '100.00')).statusCode).toBe(201);            // 10%
    expect((await bill('office_admin', '300.00')).statusCode).toBe(201);       // 30%
  });

  it('a cashier can be allowed more; a manager can be capped', async () => {
    expect((await perms(ctx.users.cashier.id, 'manager', { overrides: { 'discount.unlimited': true } })).statusCode).toBe(200);
    expect((await bill('cashier', '200.00')).statusCode).toBe(201);
    expect((await perms(ctx.users.cashier.id, 'manager', { overrides: {} })).statusCode).toBe(200);          // back to the default
    expect((await bill('cashier', '200.00')).statusCode).toBe(422);

    expect((await perms(ctx.users.manager.id, 'owner', { overrides: { 'discount.unlimited': false } })).statusCode).toBe(200);
    expect((await bill('manager', '100.00')).statusCode).toBe(422);
    expect((await perms(ctx.users.manager.id, 'owner', { overrides: {} })).statusCode).toBe(200);
  });
});

describe('actions follow the permission, not just the rank', () => {
  it('a cashier cannot change prices, move stock, add sale types or void — until given the permission', async () => {
    const types = (await inject('GET', `/sale-types/${ctx.branchId}`, 'manager')).json() as { id: string; code: string }[];
    const janata = types.find((t) => t.code === 'JANATA')!;
    const attempts = async () => ({
      mrp: (await inject('PATCH', `/products/${ctx.products[1].id}/mrp`, 'cashier', { mrp: '205' })).statusCode,
      prices: (await inject('PUT', `/sale-types/${ctx.branchId}/prices`, 'cashier', { prices: [{ productId: ctx.products[1].id, saleTypeId: janata.id, price: '150' }] })).statusCode,
      types: (await inject('POST', `/sale-types/${ctx.branchId}`, 'cashier', { name: 'Permit Room' })).statusCode,
      move: (await inject('POST', `/sale-types/${ctx.branchId}/transfer`, 'cashier', { productId: ctx.products[1].id, toSaleTypeId: janata.id, quantity: 1 })).statusCode,
    });
    expect(await attempts()).toEqual({ mrp: 403, prices: 403, types: 403, move: 403 });

    await perms(ctx.users.cashier.id, 'manager', { overrides: { 'prices.edit': true } });
    const after = await attempts();
    expect(after.mrp).toBe(200);
    expect(after.prices).toBe(200);
    expect(after.types).toBe(403);               // only what was granted
    expect(after.move).toBe(403);
    await perms(ctx.users.cashier.id, 'manager', { overrides: {} });
    expect((await attempts()).mrp).toBe(403);    // taking it away works at once
  });

  it('voiding needs bills.void', async () => {
    const made = await bill('manager', '0');
    const id = (made.json().bill ?? made.json()).id as string;
    expect((await inject('POST', `/bills/${id}/void`, 'cashier', { voidReason: 'Customer changed mind' })).statusCode).toBe(403);
    await perms(ctx.users.cashier.id, 'manager', { overrides: { 'bills.void': true } });
    expect((await inject('POST', `/bills/${id}/void`, 'cashier', { voidReason: 'Customer changed mind' })).statusCode).toBe(200);
    await perms(ctx.users.cashier.id, 'manager', { overrides: {} });
  });

  it('/me tells the app what the user may do', async () => {
    await perms(ctx.users.cashier.id, 'manager', { overrides: { 'stock.move': true } });
    const me = (await inject('GET', '/me', 'cashier')).json() as { permissions: Record<string, boolean>; discountCapPct: number | null; saleTypeIds: string[] | null };
    expect(me.permissions['stock.move']).toBe(true);
    expect(me.permissions['cost.view']).toBe(false);
    expect(me.discountCapPct).toBe(5);
    expect(me.saleTypeIds).toBeNull();
    const boss = (await inject('GET', '/me', 'office_admin')).json() as { permissions: Record<string, boolean>; discountCapPct: number | null };
    expect(Object.values(boss.permissions).every(Boolean)).toBe(true);
    expect(boss.discountCapPct).toBeNull();
    await perms(ctx.users.cashier.id, 'manager', { overrides: {} });
  });
});

describe('who can change permissions', () => {
  it('only users below you; nobody grants what they do not hold; no nonsense combinations', async () => {
    // a manager cannot touch an office admin or another manager, nor a cashier's permissions from a cashier
    expect((await perms(ctx.users.office_admin.id, 'manager', { overrides: {} })).statusCode).toBe(403);
    expect((await perms(ctx.users.manager.id, 'manager', { overrides: {} })).statusCode).toBe(403);
    expect((await perms(ctx.users.steward.id, 'cashier', { overrides: {} })).statusCode).toBe(403);
    // office admin and owner always have everything: they cannot be restricted
    const restrict = await perms(ctx.users.office_admin.id, 'owner', { overrides: { 'prices.edit': false } });
    expect(restrict.statusCode).toBe(422);
    // approving invoices needs cost.view as well
    const incoherent = await perms(ctx.users.cashier.id, 'manager', { overrides: { 'invoices.approve': true } });
    expect(incoherent.statusCode).toBe(422);
    expect(incoherent.body).toMatch(/cost prices/);
    // a manager who lost cost.view cannot hand it on
    await perms(ctx.users.manager.id, 'owner', { overrides: { 'cost.view': false } });
    const grant = await perms(ctx.users.cashier.id, 'manager', { overrides: { 'cost.view': true } });
    expect(grant.statusCode).toBe(403);
    expect(grant.body).toMatch(/cost\.view/);
    await perms(ctx.users.manager.id, 'owner', { overrides: {} });
    // ... but an office admin can
    expect((await perms(ctx.users.cashier.id, 'office_admin', { overrides: { 'cost.view': true } })).statusCode).toBe(200);
    expect(((await inject('GET', '/products', 'cashier')).json() as Record<string, unknown>[])[0]).toHaveProperty('costPrice');
    await perms(ctx.users.cashier.id, 'office_admin', { overrides: {} });
  });

  it('the settings screen can read a user\'s permissions with the role defaults', async () => {
    const res = await inject('GET', `/users/${ctx.users.cashier.id}/permissions`, 'manager');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role: string; unrestricted: boolean; canLimitSaleTypes: boolean; permissions: { key: string; roleDefault: boolean; effective: boolean }[]; discountCapPct: number | null };
    expect(body).toMatchObject({ role: 'cashier', unrestricted: false, canLimitSaleTypes: true, discountCapPct: 5 });
    expect(body.permissions.map((p) => p.key)).toContain('discount.unlimited');
    expect(body.permissions.every((p) => p.roleDefault === false && p.effective === false)).toBe(true);
    expect((await inject('GET', `/users/${ctx.users.owner.id}/permissions`, 'cashier')).statusCode).toBe(403);
  });
});

describe('office admin runs the business for the owner', () => {
  it('can do manager-and-above work, but cannot create office admins or owners; managers cannot create office admins at all', async () => {
    expect((await inject('PATCH', `/products/${ctx.products[0].id}/mrp`, 'office_admin', { mrp: '1000' })).statusCode).toBe(200);
    expect((await inject('GET', `/invoices/${ctx.branchId}`, 'office_admin')).statusCode).toBe(200);
    expect((await inject('GET', `/users?branchId=${ctx.branchId}`, 'office_admin')).statusCode).toBe(200);
    const make = (actor: Role, role: string, n: string) => inject('POST', '/users', actor, { name: `New ${n}`, email: `${n}@test.local`, password: 'Password@123', role, branchId: ctx.branchId });
    expect((await make('office_admin', 'manager', 'm1')).statusCode).toBe(201);
    expect((await make('office_admin', 'office_admin', 'oa1')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await make('office_admin', 'owner', 'ow1')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await make('manager', 'office_admin', 'oa2')).statusCode).toBeGreaterThanOrEqual(400);   // would be owner-level power
    expect((await make('manager', 'cashier', 'c1')).statusCode).toBe(201);
    // the owner-only areas (platform console, outlets, subscription) stay with the owner
    expect((await inject('POST', '/branches', 'office_admin', { name: 'X', code: 'XX1' })).statusCode).toBe(403);
    expect((await inject('GET', '/platform/dashboard', 'office_admin')).statusCode).toBe(403);
  });
});

describe('a product of another business cannot have its MRP changed', () => {
  it('reports it as missing, and the price is untouched', async () => {
    const [foreign] = await ctx.db.insert(ctx.schema.syndicates).values({ name: 'Foreign Co', maxBranches: 5 }).returning();
    const [prod] = await ctx.db.insert(ctx.schema.products).values({
      name: 'Foreign Rum 750ml', brand: 'FR', mrp: '500.00', categoryId: ctx.products[0].categoryId, volumeMl: 750, syndicateId: foreign.id,
    }).returning();
    const res = await inject('PATCH', `/products/${prod.id}/mrp`, 'manager', { mrp: '1' });
    expect(res.statusCode).toBe(404);
    const [row] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.id, prod.id));
    expect(row.mrp).toBe('500.00');
  });
});

describe('a cashier can be limited to some sale types', () => {
  it('sees, bills and counts only those', async () => {
    const types = (await inject('GET', `/sale-types/${ctx.branchId}`, 'manager')).json() as { id: string; code: string }[];
    const janata = types.find((t) => t.code === 'JANATA')!.id;
    const walkIn = types.find((t) => t.code === 'WALK_IN')!.id;
    await inject('PUT', `/sale-types/${ctx.branchId}/prices`, 'manager', { prices: [{ productId: ctx.products[0].id, saleTypeId: janata, price: '900.00' }] });
    await inject('POST', `/sale-types/${ctx.branchId}/transfer`, 'manager', { productId: ctx.products[0].id, toSaleTypeId: janata, quantity: 10 });

    // limit the cashier to Walk-in
    expect((await perms(ctx.users.cashier.id, 'manager', { overrides: {}, saleTypeIds: [walkIn] })).statusCode).toBe(200);
    const seen = (await inject('GET', `/sale-types/${ctx.branchId}`, 'cashier')).json() as { code: string }[];
    expect(seen.map((t) => t.code)).toEqual(['WALK_IN']);
    const asJanata = await bill('cashier', '0', janata);
    expect(asJanata.statusCode).toBe(403);
    expect(asJanata.body).toMatch(/not allowed/);
    expect((await bill('cashier', '0')).statusCode).toBe(201);                                     // Walk-in still fine
    const today = new Date().toISOString().slice(0, 10);
    expect((await inject('POST', `/counter-sheets/${ctx.branchId}`, 'cashier', { sheetDate: today, saleTypeId: janata })).statusCode).toBe(403);
    expect((await inject('POST', `/counter-sheets/${ctx.branchId}`, 'manager', { sheetDate: today, saleTypeId: janata })).statusCode).toBe(201);
    const sheets = (await inject('GET', `/counter-sheets/${ctx.branchId}?date=${today}`, 'cashier')).json() as { saleTypeId: string | null }[];
    expect(sheets.every((s) => s.saleTypeId === null)).toBe(true);                                 // the Janata sheet is not listed to them
    const janataSheet = (await inject('GET', `/counter-sheets/${ctx.branchId}?date=${today}&saleTypeId=${janata}`, 'manager')).json() as { id: string }[];
    expect((await inject('GET', `/counter-sheets/sheet/${janataSheet[0].id}`, 'cashier')).statusCode).toBe(403);

    // a manager cannot be limited, and the limit is only for cashiers / stewards
    expect((await perms(ctx.users.manager.id, 'owner', { overrides: {}, saleTypeIds: [walkIn] })).statusCode).toBe(422);
    // remove the limit: everything is open again
    expect((await perms(ctx.users.cashier.id, 'manager', { overrides: {}, saleTypeIds: [] })).statusCode).toBe(200);
    expect((await bill('cashier', '0', janata)).statusCode).toBe(201);
    const rows = await ctx.db.select().from(ctx.schema.userSaleTypes).where(and(eq(ctx.schema.userSaleTypes.userId, ctx.users.cashier.id)));
    expect(rows).toHaveLength(0);
  });
});

describe('dashboards by role', () => {
  it('an office admin gets the same full branch dashboard as a manager (not the cashier-sized one)', async () => {
    const mgr = (await inject('GET', `/dashboard/branch/${ctx.branchId}`, 'manager')).json() as Record<string, unknown>;
    const adm = (await inject('GET', `/dashboard/branch/${ctx.branchId}`, 'office_admin')).json() as Record<string, unknown>;
    const cashier = (await inject('GET', `/dashboard/branch/${ctx.branchId}`, 'cashier')).json() as Record<string, unknown>;
    expect(Object.keys(adm).sort()).toEqual(Object.keys(mgr).sort());                  // same shape as a manager's
    expect(Object.keys(adm).length).toBeGreaterThan(Object.keys(cashier).length);       // ... which is bigger than a cashier's
    expect(JSON.stringify(adm)).toMatch(/hourly/);                                      // the part the screen draws from
  });
});