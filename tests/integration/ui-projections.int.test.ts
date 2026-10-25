import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';

// Read projections the POS UI depends on: category names in the catalog and the open
// table session id in the table list (needed to raise KOTs / bill an occupied table).

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

describe('GET /products', () => {
  it('includes categoryName and taxRate for each product', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/products', headers: ctx.auth('cashier') });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ name: string; categoryName: string | null; taxRate: string | null; mrp: string }>;
    const whisky = list.find((p) => p.name === 'Test Whisky 750ml');
    const beer = list.find((p) => p.name === 'Test Beer 650ml');
    expect(whisky).toMatchObject({ categoryName: 'Whisky', taxRate: '18.00', mrp: '1000.00' });
    expect(beer).toMatchObject({ categoryName: 'Beer', taxRate: '12.00' });
  });
});

describe('steward table service access', () => {
  it('a steward can list the catalog (without cost price) and their own branch tables', async () => {
    const prods = await ctx.app.inject({ method: 'GET', url: '/api/v1/products', headers: ctx.auth('steward') });
    expect(prods.statusCode).toBe(200);
    const list = prods.json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('mrp');
    expect(list[0]).not.toHaveProperty('costPrice');

    const cashierList = (await ctx.app.inject({ method: 'GET', url: '/api/v1/products', headers: ctx.auth('cashier') })).json() as Array<Record<string, unknown>>;
    expect(cashierList[0]).toHaveProperty('costPrice');

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/tables/${ctx.branchId}`, headers: ctx.auth('steward') });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().tables)).toBe(true);
  });

  it('a steward from another branch cannot list this branch tables, and stewards still cannot open tables', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const [other] = await ctx.db.insert(ctx.schema.users).values({
      name: 'Other steward', email: 'steward@other.local', passwordHash: await bcrypt.hash('Password@123', 4),
      role: 'steward', branchId: ctx.otherBranchId,
    }).returning();
    const otherSteward = ctx.authFor({ sub: other.id, email: other.email, role: 'steward', branchId: ctx.otherBranchId });

    const denied = await ctx.app.inject({ method: 'GET', url: `/api/v1/tables/${ctx.branchId}`, headers: otherSteward });
    expect(denied.statusCode).toBe(403);
    const own = await ctx.app.inject({ method: 'GET', url: `/api/v1/tables/${ctx.otherBranchId}`, headers: otherSteward });
    expect(own.statusCode).toBe(200);

    const created = await ctx.app.inject({
      method: 'POST', url: `/api/v1/tables/${ctx.branchId}`, headers: ctx.auth('manager'), payload: { name: 'Steward T1' },
    });
    const tableId = created.json().table.id as string;
    const open = await ctx.app.inject({
      method: 'POST', url: `/api/v1/tables/${tableId}/open`, headers: ctx.auth('steward'), payload: { branchId: ctx.branchId },
    });
    expect(open.statusCode).toBe(403);
  });
});

describe('GET /tables/:branchId', () => {
  it('exposes the open session of an occupied table and clears it on close', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: `/api/v1/tables/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: { name: 'Proj T1', capacity: 2 },
    });
    expect(created.statusCode).toBe(201);
    const tableId = created.json().table.id as string;

    const list = async () => {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/tables/${ctx.branchId}`, headers: ctx.auth('cashier') });
      expect(res.statusCode).toBe(200);
      return (res.json().tables as Array<{ id: string; status: string; currentSessionId: string | null; sessionGuestCount: number | null }>)
        .find((t) => t.id === tableId)!;
    };

    expect((await list()).currentSessionId).toBeNull();

    const opened = await ctx.app.inject({
      method: 'POST', url: `/api/v1/tables/${tableId}/open`, headers: ctx.auth('cashier'),
      payload: { branchId: ctx.branchId, guestCount: 3 },
    });
    expect(opened.statusCode).toBe(201);
    const sessionId = opened.json().session.id as string;

    const occupied = await list();
    expect(occupied.status).toBe('OCCUPIED');
    expect(occupied.currentSessionId).toBe(sessionId);
    expect(occupied.sessionGuestCount).toBe(3);

    const closed = await ctx.app.inject({
      method: 'POST', url: `/api/v1/tables/${tableId}/close`, headers: ctx.auth('cashier'),
      payload: { branchId: ctx.branchId },
    });
    expect(closed.statusCode).toBe(200);
    expect((await list()).currentSessionId).toBeNull();
  });
});
