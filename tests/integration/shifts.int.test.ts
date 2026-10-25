import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { terminalRoutes } from '../../src/modules/terminals/terminal.routes.js';
import { shiftRoutes } from '../../src/modules/shifts/shift.routes.js';

let ctx: IntegrationContext;
let app: FastifyInstance;   // local instance with the phase-2 routes (independent of buildApp wiring)
let whiskyId: string;
let beerId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  whiskyId = ctx.products[0].id;
  beerId = ctx.products[1].id;
  app = Fastify();
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  app.register(terminalRoutes, { prefix: '/api/v1' });
  app.register(shiftRoutes, { prefix: '/api/v1' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.app.close();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

function createTerminal(terminalName: string, headers = ctx.auth('manager'), branchId = ctx.branchId) {
  return app.inject({ method: 'POST', url: `/api/v1/terminals/${branchId}`, headers, payload: { terminalName } });
}

function openShift(terminalId: string, headers = ctx.auth('cashier'), openingFloat: unknown = '500.00') {
  return app.inject({ method: 'POST', url: '/api/v1/shifts/open', headers, payload: { terminalId, openingFloat } });
}

function postBill(paymentMode: string, items: { productId: string; quantity: number }[]) {
  return ctx.app.inject({
    method: 'POST', url: '/api/v1/bills', headers: ctx.auth('cashier'),
    payload: { branchId: ctx.branchId, paymentMode, items },
  });
}

// ─── TERMINALS ────────────────────────────────────────────────────────────────

let t1: string;
let t2: string;

describe('terminals', () => {
  it('creates terminals with a generated unique deviceKey; duplicate name is 409', async () => {
    const a = await createTerminal('Counter 1');
    const b = await createTerminal('Counter 2');
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().deviceKey).toMatch(/^[0-9a-f]{32}$/);
    expect(a.json().deviceKey).not.toBe(b.json().deviceKey);
    t1 = a.json().id;
    t2 = b.json().id;

    const dup = await createTerminal('Counter 1');
    expect(dup.statusCode).toBe(409);
  });

  it('lists for manager (with deviceKey) and cashier (without, so they can pick a terminal); denies steward and other-branch manager (403)', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/terminals/${ctx.branchId}`, headers: ctx.auth('manager') });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(2);
    expect(list.json()[0].deviceKey).toMatch(/^[0-9a-f]{32}$/);
    const cashier = await app.inject({ method: 'GET', url: `/api/v1/terminals/${ctx.branchId}`, headers: ctx.auth('cashier') });
    expect(cashier.statusCode).toBe(200);
    expect(cashier.json()).toHaveLength(2);
    expect(cashier.json()[0]).toMatchObject({ id: expect.any(String), terminalName: 'Counter 1', isActive: true });
    expect(cashier.json()[0].deviceKey).toBeUndefined();
    const steward = await app.inject({ method: 'GET', url: `/api/v1/terminals/${ctx.branchId}`, headers: ctx.auth('steward') });
    expect(steward.statusCode).toBe(403);
    const cross = await app.inject({ method: 'GET', url: `/api/v1/terminals/${ctx.branchId}`, headers: otherManager() });
    expect(cross.statusCode).toBe(403);
    const crossPatch = await app.inject({ method: 'PATCH', url: `/api/v1/terminals/${t1}`, headers: otherManager(), payload: { isActive: false } });
    expect(crossPatch.statusCode).toBe(403);
  });
});

// ─── SHIFTS ───────────────────────────────────────────────────────────────────

describe('shift lifecycle', () => {
  let shiftId: string;

  it('rejects opening on an inactive terminal (422) and on another branch terminal (403)', async () => {
    const t3 = (await createTerminal('Counter 3')).json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/terminals/${t3}`, headers: ctx.auth('manager'), payload: { isActive: false } });
    expect((await openShift(t3)).statusCode).toBe(422);
    expect((await openShift(t1, otherManager())).statusCode).toBe(403);
    expect((await openShift(t1, ctx.auth('steward'))).statusCode).toBe(403);
  });

  it('opens one shift per cashier and per terminal (409 otherwise)', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/v1/shifts/current', headers: ctx.auth('cashier') });
    expect(none.json()).toEqual({ shift: null });

    const opened = await openShift(t1);
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({ status: 'OPEN', openingFloat: '500.00', branchId: ctx.branchId });
    shiftId = opened.json().id;

    expect((await openShift(t2)).statusCode).toBe(409);                       // cashier busy
    expect((await openShift(t1, ctx.auth('manager'))).statusCode).toBe(409);  // terminal busy

    const deactivate = await app.inject({ method: 'PATCH', url: `/api/v1/terminals/${t1}`, headers: ctx.auth('manager'), payload: { isActive: false } });
    expect(deactivate.statusCode).toBe(409);
  });

  it('concurrent opens by the same cashier create exactly one shift', async () => {
    const [m1, m2] = [await createTerminal('Race A'), await createTerminal('Race B')].map((r) => r.json().id);
    const results = await Promise.all([openShift(m1, ctx.auth('manager')), openShift(m2, ctx.auth('manager'))]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('links bills and reports live totals (VOIDED excluded)', async () => {
    expect((await postBill('CASH', [{ productId: whiskyId, quantity: 1 }])).statusCode).toBe(201);   // 1000
    expect((await postBill('UPI', [{ productId: beerId, quantity: 1 }])).statusCode).toBe(201);      // 200
    expect((await postBill('CARD', [{ productId: beerId, quantity: 1 }])).statusCode).toBe(201);     // 200
    const toVoid = await postBill('CASH', [{ productId: beerId, quantity: 2 }]);                      // 400, voided
    expect(toVoid.json().shiftSessionId).toBe(shiftId);
    const voided = await ctx.app.inject({
      method: 'POST', url: `/api/v1/bills/${toVoid.json().id}/void`, headers: ctx.auth('manager'),
      payload: { voidReason: 'Customer changed mind' },
    });
    expect(voided.statusCode).toBe(200);

    const current = await app.inject({ method: 'GET', url: '/api/v1/shifts/current', headers: ctx.auth('cashier') });
    expect(current.statusCode).toBe(200);
    expect(current.json().shift.id).toBe(shiftId);
    expect(current.json().shift.terminalName).toBe('Counter 1');
    expect(current.json().shift.summary).toMatchObject({
      cashCollected: '1000.00', upiCollected: '200.00', cardCollected: '200.00', creditCollected: '0.00',
      paidBillsCount: 3, expectedCash: '1500.00',
    });
  });

  it('validates denominations (400) and denies other-branch managers / other cashiers (403)', async () => {
    const bad = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shiftId}/close`, headers: ctx.auth('cashier'),
      payload: { denominations: { '300': 1 } },
    });
    expect(bad.statusCode).toBe(400);
    const neg = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shiftId}/close`, headers: ctx.auth('cashier'),
      payload: { denominations: { '500': -1 } },
    });
    expect(neg.statusCode).toBe(400);
    // amounts beyond numeric(12,2) are a validation error, not a DB overflow
    const huge = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shiftId}/close`, headers: ctx.auth('cashier'),
      payload: { denominations: { coins: '99999999999.00' } },
    });
    expect(huge.statusCode).toBe(400);
    const hugeFloat = await openShift(t2, ctx.auth('manager'), '99999999999');
    expect(hugeFloat.statusCode).toBe(400);
    const cross = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shiftId}/close`, headers: otherManager(),
      payload: { denominations: { '500': 1 } },
    });
    expect(cross.statusCode).toBe(403);
  });

  it('closes with a discrepancy computed from real bills; closing twice is 409', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shiftId}/close`, headers: ctx.auth('cashier'),
      payload: { denominations: { '500': 2, '200': 2, coins: '50.00' }, notes: 'short by 50' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'CLOSED', cashCollected: '1000.00', upiCollected: '200.00', cardCollected: '200.00',
      expectedCash: '1500.00', countedCash: '1450.00', discrepancy: '-50.00', notes: 'short by 50',
    });
    expect(res.json().closedAt).toBeTruthy();

    const [row] = await ctx.db.select().from(ctx.schema.shiftSessions).where(eq(ctx.schema.shiftSessions.id, shiftId));
    expect(row.status).toBe('CLOSED');
    expect(row.denominations).toEqual({ '500': 2, '200': 2, coins: '50.00' });

    const again = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shiftId}/close`, headers: ctx.auth('manager'),
      payload: { denominations: { '500': 3 } },
    });
    expect(again.statusCode).toBe(409);

    // bills rung after close are not linked to the closed shift
    const later = await postBill('CASH', [{ productId: beerId, quantity: 1 }]);
    expect(later.json().shiftSessionId).toBeNull();
  });

  it('GET /shifts lists the branch shifts for managers only', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/shifts?branchId=${ctx.branchId}`, headers: ctx.auth('manager') });
    expect(list.statusCode).toBe(200);
    const mine = list.json().find((s: any) => s.id === shiftId);
    expect(mine).toMatchObject({ status: 'CLOSED', terminalName: 'Counter 1', cashierName: 'Test cashier' });

    const cashier = await app.inject({ method: 'GET', url: `/api/v1/shifts?branchId=${ctx.branchId}`, headers: ctx.auth('cashier') });
    expect(cashier.statusCode).toBe(403);
    const cross = await app.inject({ method: 'GET', url: `/api/v1/shifts?branchId=${ctx.branchId}`, headers: otherManager() });
    expect(cross.statusCode).toBe(403);
  });
});
