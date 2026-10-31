import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let barId: string;
let peg60: string;
let foodId: string;
let superAdmin: { authorization: string };

beforeAll(async () => {
  ctx = await setupIntegration();
  await ctx.db.update(ctx.schema.branches)
    .set({ gstin: '36ABCDE1234F1Z5', address: '1 High St' })
    .where(eq(ctx.schema.branches.id, ctx.branchId));

  const bar = (await ctx.app.inject({
    method: 'POST', url: '/api/v1/menu/bar', headers: ctx.auth('manager'),
    payload: { name: 'Blend 750ml', categoryName: 'Whisky', price: '2400', gstRate: '18', volumeMl: 750, hsnCode: '22083020',
      servings: [{ label: '60 ml', volumeMl: 60, price: '240' }] },
  })).json();
  barId = bar.id;
  peg60 = bar.servings[0].id;
  await ctx.db.insert(ctx.schema.stock).values({ branchId: ctx.branchId, productId: barId, quantity: 4 });
  foodId = (await ctx.app.inject({
    method: 'POST', url: '/api/v1/menu/kitchen', headers: ctx.auth('manager'),
    payload: { name: 'Chicken 65', categoryName: 'Starters', price: '210', gstRate: '5', hsnCode: '9963' },
  })).json().id;

  // Platform owner (Super Admin): no branch, no syndicate
  const hash = await bcrypt.hash('Password@123', 4);
  const [sa] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform Root', email: 'root@saas.local', passwordHash: hash, role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdmin = ctx.authFor({ sub: sa.id, email: sa.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

const stockRow = async (productId: string) => {
  const [r] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId)));
  return r;
};
const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: { authorization: string }, payload?: unknown) =>
  ctx.app.inject({ method, url, headers, payload: payload as object | undefined });

describe('table checkout', () => {
  let tableId: string;
  let sessionId: string;

  it('bills KOT items (peg + kitchen) into one bill, deducts ml, closes the table', async () => {
    const table = (await inject('POST', `/api/v1/tables/${ctx.branchId}`, ctx.auth('manager'), { name: 'T-9' })).json().table;
    tableId = table.id;
    sessionId = (await inject('POST', `/api/v1/tables/${tableId}/open`, ctx.auth('cashier'), { branchId: ctx.branchId })).json().session.id;
    const k1 = await inject('POST', '/api/v1/kot', ctx.auth('steward'), {
      tableSessionId: sessionId, branchId: ctx.branchId, destination: 'BAR', items: [{ productId: barId, servingId: peg60, quantity: 3 }],
    });
    const k2 = await inject('POST', '/api/v1/kot', ctx.auth('steward'), {
      tableSessionId: sessionId, branchId: ctx.branchId, destination: 'KITCHEN', items: [{ productId: foodId, quantity: 2 }],
    });
    expect(k1.statusCode).toBe(201);
    // cancel one of the food items' KOT line to prove cancelled lines are not billed
    const cancelled = await inject('POST', '/api/v1/kot', ctx.auth('steward'), {
      tableSessionId: sessionId, branchId: ctx.branchId, items: [{ productId: foodId, quantity: 5 }],
    });
    const c = cancelled.json().kotOrder;
    await inject('PATCH', `/api/v1/kot/${c.id}/items/${c.items[0].id}`, ctx.auth('steward'), { status: 'CANCELLED', branchId: ctx.branchId });
    expect(k2.statusCode).toBe(201);

    const res = await inject('POST', `/api/v1/tables/${tableId}/checkout`, ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'UPI' });
    expect(res.statusCode).toBe(201);
    const { bill } = res.json();
    expect(bill.total).toBe('1140.00');           // 3 x 240 + 2 x 210
    expect(bill.items).toHaveLength(2);
    const s = await stockRow(barId);
    expect(s.quantity).toBe(3);
    expect(s.openMl).toBe(570);                    // one bottle opened, 180 ml poured

    const [session] = await ctx.db.select().from(ctx.schema.tableSessions).where(eq(ctx.schema.tableSessions.id, sessionId));
    expect(session.billId).toBe(bill.id);
    expect(session.closedAt).not.toBeNull();
    const [t] = await ctx.db.select().from(ctx.schema.tables).where(eq(ctx.schema.tables.id, tableId));
    expect(t.status).toBe('FREE');
  });

  it('refuses a second checkout and an empty table', async () => {
    expect((await inject('POST', `/api/v1/tables/${tableId}/checkout`, ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH' })).statusCode).toBe(404);
    const t2 = (await inject('POST', `/api/v1/tables/${ctx.branchId}`, ctx.auth('manager'), { name: 'T-10' })).json().table;
    await inject('POST', `/api/v1/tables/${t2.id}/open`, ctx.auth('cashier'), { branchId: ctx.branchId });
    expect((await inject('POST', `/api/v1/tables/${t2.id}/checkout`, ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH' })).statusCode).toBe(422);
  });

  it('a steward cannot check out', async () => {
    expect((await inject('POST', `/api/v1/tables/${tableId}/checkout`, ctx.auth('steward'), { branchId: ctx.branchId, paymentMode: 'CASH' })).statusCode).toBe(403);
  });
});

describe('GST: HSN, derived IGST, round-off', () => {
  it('prints HSN and picks CGST+SGST for a same-state buyer, IGST for another state', async () => {
    const same = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', customerGstin: '36AAAAA0000A1Z5',
      items: [{ productId: foodId, quantity: 1 }, { productId: barId, servingId: peg60, quantity: 1 }],
    })).json();
    const t1 = (await inject('GET', `/api/v1/print/bills/${same.id}?format=text`, ctx.auth('cashier'))).body;
    expect(t1).toContain('Buyer GSTIN: 36AAAAA0000A1Z5');
    expect(t1).toContain('HSN 9963');
    expect(t1).toContain('HSN 22083020');
    expect(t1).toContain('SGST');
    expect(t1).not.toContain('IGST');

    const other = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', customerGstin: '29AAAAA0000A1Z5', items: [{ productId: foodId, quantity: 1 }],
    })).json();
    const t2 = (await inject('GET', `/api/v1/print/bills/${other.id}?format=text`, ctx.auth('cashier'))).body;
    expect(t2).toContain('IGST');
    expect(t2).not.toContain('SGST');
    // explicit override still wins
    const forced = (await inject('GET', `/api/v1/print/bills/${other.id}?format=text&interState=false`, ctx.auth('cashier'))).body;
    expect(forced).toContain('SGST');
  });

  it('round-off is opt-in, stored on the bill, shown on the receipt, and the books still balance', async () => {
    const plain = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: barId, servingId: peg60, quantity: 1 }, { productId: foodId, quantity: 1 }],
    })).json();
    expect(plain.roundOff).toBe('0.00');

    const patch = await inject('PATCH', `/api/v1/branches/${ctx.branchId}`, ctx.auth('owner'), { roundOff: true });
    expect(patch.statusCode).toBe(200);

    const down = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', discount: '0.40', items: [{ productId: foodId, quantity: 1 }],
    })).json();                                     // 210.00 - 0.40 = 209.60 -> 210.00
    expect(down.total).toBe('210.00');
    expect(down.roundOff).toBe('0.40');

    const up = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', discount: '0.60', items: [{ productId: foodId, quantity: 1 }],
    })).json();                                     // 209.40 -> 209.00
    expect(up.total).toBe('209.00');
    expect(up.roundOff).toBe('-0.40');

    const text = (await inject('GET', `/api/v1/print/bills/${up.id}?format=text`, ctx.auth('cashier'))).body;
    expect(text).toContain('Round off');
    expect(text).toMatch(/TOTAL\s+209\.00/);

    // every voucher balances, and the round-off ledger carries the differences
    const totals = await ctx.db.execute(sql`select coalesce(sum(debit),0)::text d, coalesce(sum(credit),0)::text c from journal_lines`);
    const row = (totals as unknown as { rows?: { d: string; c: string }[] }).rows?.[0] ?? (totals as unknown as { d: string; c: string }[])[0];
    expect(row.d).toBe(row.c);
    const void1 = await inject('POST', `/api/v1/bills/${up.id}/void`, ctx.auth('manager'), { voidReason: 'Test void round-off' });
    expect(void1.statusCode).toBe(200);

    await inject('PATCH', `/api/v1/branches/${ctx.branchId}`, ctx.auth('owner'), { roundOff: false });
  });
});

describe('open-bottle ml and pour variance', () => {
  it('stock status exposes open ml', async () => {
    const res = await inject('GET', `/api/v1/inventory/stock/${ctx.branchId}`, ctx.auth('cashier'));
    const row = res.json().find((r: { productId: string }) => r.productId === barId);
    expect(row.openMl).toBeGreaterThan(0);
  });

  it('a physical count records the shortage, adjusts the system and feeds the report', async () => {
    const before = (await stockRow(barId)).openMl;
    const res = await inject('POST', `/api/v1/compliance/pour-counts/${ctx.branchId}`, ctx.auth('manager'), {
      productId: barId, countedMl: before - 90, note: 'End of night dip',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ expectedMl: before, countedMl: before - 90, varianceMl: -90 });
    expect((await stockRow(barId)).openMl).toBe(before - 90);

    const today = new Date().toISOString().slice(0, 10);
    const report = (await inject('GET', `/api/v1/compliance/pour-report/${ctx.branchId}?from=${today}&to=${today}`, ctx.auth('manager'))).json();
    const row = report.rows.find((r: { productId: string }) => r.productId === barId);
    expect(row.varianceMl).toBe(-90);
    expect(row.soldMl).toBeGreaterThan(0);
    expect(row.varianceValue).toBe('-288.00');       // 90 ml x (2400 / 750)
    expect(Number(row.variancePercent)).toBeLessThan(0);
    expect(report.totals.varianceMl).toBe(-90);
  });

  it('rejects an impossible count and non-managers', async () => {
    expect((await inject('POST', `/api/v1/compliance/pour-counts/${ctx.branchId}`, ctx.auth('manager'), { productId: barId, countedMl: 900 })).statusCode).toBe(422);
    expect((await inject('POST', `/api/v1/compliance/pour-counts/${ctx.branchId}`, ctx.auth('cashier'), { productId: barId, countedMl: 100 })).statusCode).toBe(403);
  });
});

describe('menu tenancy and branch availability', () => {
  it("another business cannot see or sell a tenant's menu items", async () => {
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    const list = (await inject('GET', '/api/v1/menu/kitchen', other)).json().items.map((i: { id: string }) => i.id);
    expect(list).not.toContain(foodId);
    expect((await inject('PATCH', `/api/v1/menu/items/${foodId}`, other, { price: '1' })).statusCode).toBe(404);
    const bill = await inject('POST', '/api/v1/bills', other, { branchId: ctx.otherBranchId, paymentMode: 'CASH', items: [{ productId: foodId, quantity: 1 }] });
    expect(bill.statusCode).toBe(422);
    const products = (await inject('GET', '/api/v1/products', other)).json().map((p: { id: string }) => p.id);
    expect(products).not.toContain(foodId);
  });

  it('a branch can switch an item off for itself only', async () => {
    const off = await inject('PUT', `/api/v1/menu/items/${foodId}/branch-availability`, ctx.auth('manager'), { branchId: ctx.branchId, isAvailable: false });
    expect(off.statusCode).toBe(200);
    const list = (await inject('GET', `/api/v1/menu/kitchen?branchId=${ctx.branchId}`, ctx.auth('manager'))).json().items;
    expect(list.find((i: { id: string }) => i.id === foodId)).toMatchObject({ isAvailable: false, branchOverride: true, sharedAvailable: true });
    expect((await inject('POST', '/api/v1/bills', ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: foodId, quantity: 1 }] })).statusCode).toBe(422);
    await inject('PUT', `/api/v1/menu/items/${foodId}/branch-availability`, ctx.auth('manager'), { branchId: ctx.branchId, isAvailable: true });
    expect((await inject('POST', '/api/v1/bills', ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: foodId, quantity: 1 }] })).statusCode).toBe(201);
  });
});

describe('Super Admin and Admin', () => {
  let tenantId: string;

  it('only the Super Admin can use /platform', async () => {
    expect((await inject('GET', '/api/v1/platform/tenants', ctx.auth('owner'))).statusCode).toBe(403);   // an Admin (syndicate owner)
    expect((await inject('GET', '/api/v1/platform/tenants', ctx.auth('manager'))).statusCode).toBe(403);
    expect((await inject('GET', '/api/v1/platform/tenants', superAdmin)).statusCode).toBe(200);
  });

  it('creates a tenant with its first Admin, who can sign in', async () => {
    const res = await inject('POST', '/api/v1/platform/tenants', superAdmin, {
      name: 'Blue Lagoon Bars', plan: 'TRIAL', admin: { name: 'Meera', email: 'Meera@BlueLagoon.test', password: 'Sup3rSecret!' },
    });
    expect(res.statusCode).toBe(201);
    tenantId = res.json().tenant.id;
    expect(res.json().tenant).toMatchObject({ plan: 'TRIAL', maxBranches: 1, isActive: true });
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'meera@bluelagoon.test', password: 'Sup3rSecret!' } });
    expect(login.statusCode).toBe(200);

    const dup = await inject('POST', '/api/v1/platform/tenants', superAdmin, {
      name: 'Dup', admin: { name: 'X', email: 'meera@bluelagoon.test', password: 'Sup3rSecret!' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("the Admin sees their plan and cannot exceed the plan's branch limit", async () => {
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'meera@bluelagoon.test', password: 'Sup3rSecret!' } })).json().token;
    const admin = { authorization: `Bearer ${token}` };
    const me = (await inject('GET', '/api/v1/tenant/me', admin)).json();
    expect(me).toMatchObject({ plan: 'TRIAL', maxBranches: 1, branchCount: 0 });

    const first = await inject('POST', '/api/v1/branches', admin, { name: 'Lagoon One', code: 'LAG1' });
    expect(first.statusCode).toBe(201);
    const second = await inject('POST', '/api/v1/branches', admin, { name: 'Lagoon Two', code: 'LAG2' });
    expect(second.statusCode).toBe(422);
    expect(second.json().error).toMatch(/Plan limit reached/);

    // Super Admin upgrades the plan; the limit follows
    const up = await inject('PATCH', `/api/v1/platform/tenants/${tenantId}`, superAdmin, { plan: 'STANDARD' });
    expect(up.json()).toMatchObject({ plan: 'STANDARD', maxBranches: 3 });
    expect((await inject('POST', '/api/v1/branches', admin, { name: 'Lagoon Two', code: 'LAG2' })).statusCode).toBe(201);
  });

  it('suspending a tenant blocks sign-in and existing sessions; reactivating restores them', async () => {
    const login = () => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'meera@bluelagoon.test', password: 'Sup3rSecret!' } });
    const token = (await login()).json().token;

    expect((await inject('PATCH', `/api/v1/platform/tenants/${tenantId}`, superAdmin, { isActive: false })).statusCode).toBe(200);
    const blocked = await login();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatch(/suspended/);
    expect((await inject('GET', '/api/v1/tenant/me', { authorization: `Bearer ${token}` })).statusCode).toBe(403);

    await inject('PATCH', `/api/v1/platform/tenants/${tenantId}`, superAdmin, { isActive: true });
    expect((await login()).statusCode).toBe(200);
  });

  it('overview and tenant list report usage', async () => {
    const overview = (await inject('GET', '/api/v1/platform/overview', superAdmin)).json();
    expect(overview.tenants).toBeGreaterThanOrEqual(2);
    const list = (await inject('GET', '/api/v1/platform/tenants', superAdmin)).json().tenants;
    const test = list.find((t: { name: string }) => t.name === 'Test Syndicate');
    expect(test.bills30d).toBeGreaterThan(0);
    expect(test.branchCount).toBeGreaterThanOrEqual(1);
    const blue = list.find((t: { id: string }) => t.id === tenantId);
    expect(blue.admins[0].email).toBe('meera@bluelagoon.test');
  });
});
