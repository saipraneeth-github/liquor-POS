import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { customerRoutes } from '../../src/modules/customers/customer.routes.js';
import { schemeRoutes } from '../../src/modules/schemes/scheme.routes.js';
import { onDomainEvent } from '../../src/lib/domain-events.js';

let ctx: IntegrationContext;
let app: FastifyInstance;   // local app with the Phase 3 plugins (works before and after wiring into buildApp)

beforeAll(async () => {
  ctx = await setupIntegration();
  app = Fastify();
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  app.register(customerRoutes, { prefix: '/api/v1' });
  app.register(schemeRoutes, { prefix: '/api/v1' });
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

function createCustomer(payload: Record<string, unknown>, headers = ctx.auth('manager'), branchId = ctx.branchId) {
  return app.inject({ method: 'POST', url: `/api/v1/customers/${branchId}`, headers, payload });
}

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────

describe('customers', () => {
  it('cashier can create a non-credit customer; phone is normalised', async () => {
    const res = await createCustomer({ name: 'Ravi', phone: '+91 98765 00001' }, ctx.auth('cashier'));
    expect(res.statusCode).toBe(201);
    expect(res.json().customer).toMatchObject({ phone: '9876500001', creditAllowed: false, creditLimit: '0.00' });
  });

  it('cashier cannot grant credit (403); invalid phone is 400', async () => {
    const forbidden = await createCustomer({ name: 'X', phone: '9876500002', creditAllowed: true, creditLimit: '500' }, ctx.auth('cashier'));
    expect(forbidden.statusCode).toBe(403);
    const bad = await createCustomer({ name: 'X', phone: '12345' });
    expect(bad.statusCode).toBe(400);
  });

  it('money beyond numeric(12,2) is a 400 validation error, not a DB failure', async () => {
    const res = await createCustomer({ name: 'Big', phone: '9876500099', creditAllowed: true, creditLimit: '100000000000' });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate phone in the same branch → 409', async () => {
    const res = await createCustomer({ name: 'Ravi again', phone: '9876500001' });
    expect(res.statusCode).toBe(409);
  });

  it('search by name or phone', async () => {
    const byName = await app.inject({ method: 'GET', url: `/api/v1/customers/${ctx.branchId}?search=rav`, headers: ctx.auth('cashier') });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().customers.map((c: any) => c.name)).toContain('Ravi');
    const byPhone = await app.inject({ method: 'GET', url: `/api/v1/customers/${ctx.branchId}?search=500001`, headers: ctx.auth('cashier') });
    expect(byPhone.json().customers).toHaveLength(1);
  });

  it('cross-branch access is denied (403)', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/customers/${ctx.branchId}`, headers: otherManager() });
    expect(list.statusCode).toBe(403);
    const create = await createCustomer({ name: 'Y', phone: '9876500003' }, otherManager());
    expect(create.statusCode).toBe(403);
  });

  it('CREDIT bill → statement → repayment → outstanding, with over-repayment 422', async () => {
    const created = await createCustomer({ name: 'Khata Kumar', phone: '9876500010', creditAllowed: true, creditLimit: '5000' });
    expect(created.statusCode).toBe(201);
    const customer = created.json().customer;

    // CREDIT bill through the real billing route
    const bill = await ctx.app.inject({
      method: 'POST', url: '/api/v1/bills', headers: ctx.auth('cashier'),
      payload: { branchId: ctx.branchId, paymentMode: 'CREDIT', customerId: customer.id, items: [{ productId: ctx.products[0].id, quantity: 2 }] },
    });
    expect(bill.statusCode).toBe(201);
    expect(bill.json().total).toBe('2000.00');

    // Limit cannot drop below outstanding
    const lowLimit = await app.inject({ method: 'PATCH', url: `/api/v1/customers/${customer.id}`, headers: ctx.auth('manager'), payload: { creditLimit: '1999.99' } });
    expect(lowLimit.statusCode).toBe(422);
    const cashierPatch = await app.inject({ method: 'PATCH', url: `/api/v1/customers/${customer.id}`, headers: ctx.auth('cashier'), payload: { creditLimit: '9000' } });
    expect(cashierPatch.statusCode).toBe(403);
    const rename = await app.inject({ method: 'PATCH', url: `/api/v1/customers/${customer.id}`, headers: ctx.auth('cashier'), payload: { name: 'Khata K.' } });
    expect(rename.statusCode).toBe(200);

    // Over-repayment
    const over = await app.inject({ method: 'POST', url: `/api/v1/customers/${customer.id}/repayments`, headers: ctx.auth('cashier'), payload: { amount: '2000.01', paymentMode: 'CASH' } });
    expect(over.statusCode).toBe(422);

    // Valid repayment emits credit.repayment inside the tx
    const seen: string[] = [];
    const off = onDomainEvent('credit.repayment', ({ txn }) => { seen.push(txn.amount); });
    const repay = await app.inject({ method: 'POST', url: `/api/v1/customers/${customer.id}/repayments`, headers: ctx.auth('cashier'), payload: { amount: '750.50', paymentMode: 'UPI', notes: 'part' } });
    off();
    expect(repay.statusCode).toBe(201);
    expect(repay.json().customer.currentCredit).toBe('1249.50');
    expect(repay.json().txn).toMatchObject({ type: 'REPAYMENT', amount: '750.50', balanceAfter: '1249.50', paymentMode: 'UPI' });
    expect(seen).toEqual(['750.50']);

    // Same clientRef submitted twice (double-tap / offline retry) records ONE repayment
    const keyed = { amount: '100.00', paymentMode: 'CASH', clientRef: 'repay-abc-1' };
    const first = await app.inject({ method: 'POST', url: `/api/v1/customers/${customer.id}/repayments`, headers: ctx.auth('cashier'), payload: keyed });
    const replay = await app.inject({ method: 'POST', url: `/api/v1/customers/${customer.id}/repayments`, headers: ctx.auth('cashier'), payload: keyed });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().txn.id).toBe(first.json().txn.id);
    expect(first.json().customer.currentCredit).toBe('1149.50');
    // undo it so the balances asserted below stay unchanged
    await ctx.db.update(ctx.schema.customers).set({ currentCredit: '1249.50' }).where(eq(ctx.schema.customers.id, customer.id));
    await ctx.db.delete(ctx.schema.creditTransactions).where(eq(ctx.schema.creditTransactions.clientRef, 'repay-abc-1'));

    const [row] = await ctx.db.select().from(ctx.schema.customers).where(eq(ctx.schema.customers.id, customer.id));
    expect(row.currentCredit).toBe('1249.50');

    // Statement newest first with running balance
    const stmt = await app.inject({ method: 'GET', url: `/api/v1/customers/${customer.id}/statement`, headers: ctx.auth('cashier') });
    expect(stmt.statusCode).toBe(200);
    const s = stmt.json();
    expect(s.entries.map((e: any) => [e.type, e.runningBalance])).toEqual([['REPAYMENT', '1249.50'], ['PURCHASE', '2000.00']]);
    expect(s.closingBalance).toBe('1249.50');
    expect(s.outstanding).toBe('1249.50');

    // Outstanding (manager+)
    const cashierOut = await app.inject({ method: 'GET', url: `/api/v1/customers/${ctx.branchId}/outstanding`, headers: ctx.auth('cashier') });
    expect(cashierOut.statusCode).toBe(403);
    const out = await app.inject({ method: 'GET', url: `/api/v1/customers/${ctx.branchId}/outstanding`, headers: ctx.auth('manager') });
    expect(out.statusCode).toBe(200);
    expect(out.json().totalOutstanding).toBe('1249.50');
    expect(out.json().customers.map((c: any) => c.id)).toEqual([customer.id]);

    // Cross-branch repayment / statement denied
    const xStmt = await app.inject({ method: 'GET', url: `/api/v1/customers/${customer.id}/statement`, headers: otherManager() });
    expect(xStmt.statusCode).toBe(403);
    const xRepay = await app.inject({ method: 'POST', url: `/api/v1/customers/${customer.id}/repayments`, headers: otherManager(), payload: { amount: '1', paymentMode: 'CASH' } });
    expect(xRepay.statusCode).toBe(403);
  });

  it('unknown customer → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/customers/00000000-0000-0000-0000-000000000000/statement', headers: ctx.auth('manager') });
    expect(res.statusCode).toBe(404);
  });
});

// ─── SCHEME SLABS ─────────────────────────────────────────────────────────────

describe('scheme slabs & payout', () => {
  let schemeId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/schemes/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: {
        supplierName: 'United Spirits', schemeName: 'Q4 case push', targetType: 'QTY', targetValue: '100',
        rewardDescription: 'Slab rewards', startDate: '2026-10-01', endDate: '2026-12-31',
      },
    });
    expect(res.statusCode).toBe(201);
    schemeId = res.json().scheme.id;
  });

  it('replaces slabs atomically and lists them sorted', async () => {
    const first = await app.inject({
      method: 'POST', url: `/api/v1/schemes/${schemeId}/slabs`, headers: ctx.auth('manager'),
      payload: { slabs: [{ minCases: 5, freeBottles: 1, discountPerCase: '10' }] },
    });
    expect(first.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/schemes/${schemeId}/slabs`, headers: ctx.auth('manager'),
      payload: { slabs: [
        { minCases: 50, freeBottles: 15, discountPerCase: '100' },
        { minCases: 10, freeBottles: 2, discountPerCase: '50' },
        { minCases: 25, freeBottles: 6, discountPerCase: '75' },
      ] },
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: `/api/v1/schemes/${schemeId}/slabs`, headers: ctx.auth('manager') });
    expect(list.json().slabs.map((s: any) => s.minCases)).toEqual([10, 25, 50]);

    const dup = await app.inject({
      method: 'POST', url: `/api/v1/schemes/${schemeId}/slabs`, headers: ctx.auth('manager'),
      payload: { slabs: [{ minCases: 10 }, { minCases: 10 }] },
    });
    expect(dup.statusCode).toBe(400);

    const overflow = await app.inject({
      method: 'POST', url: `/api/v1/schemes/${schemeId}/slabs`, headers: ctx.auth('manager'),
      payload: { slabs: [{ minCases: 1, discountPerCase: '100000000000' }] },
    });
    expect(overflow.statusCode).toBe(400);
  });

  it('payout evaluates recorded purchases (cases) against the best slab', async () => {
    for (const qty of ['20', '12']) {
      const p = await app.inject({ method: 'POST', url: `/api/v1/schemes/${schemeId}/purchase`, headers: ctx.auth('manager'), payload: { qty, value: '1000' } });
      expect(p.statusCode).toBe(201);
    }
    const res = await app.inject({ method: 'GET', url: `/api/v1/schemes/${schemeId}/payout`, headers: ctx.auth('manager') });
    expect(res.statusCode).toBe(200);
    const { payout } = res.json();
    expect(payout.totalCases).toBe('32.00');
    expect(payout.slab.minCases).toBe(25);
    expect(payout.freeBottles).toBe(6);
    expect(payout.discountTotal).toBe('2400.00');
    expect(payout.nextSlab.minCases).toBe(50);
    expect(payout.casesToNextSlab).toBe('18.00');
    expect(payout.purchaseCount).toBe(2);
  });

  it('existing scheme list/alerts routes still resolve alongside slab routes', async () => {
    const alerts = await app.inject({ method: 'GET', url: `/api/v1/schemes/${ctx.branchId}/alerts`, headers: ctx.auth('manager') });
    expect(alerts.statusCode).toBe(200);
  });

  it('slab routes enforce role and branch access', async () => {
    const cashier = await app.inject({ method: 'GET', url: `/api/v1/schemes/${schemeId}/payout`, headers: ctx.auth('cashier') });
    expect(cashier.statusCode).toBe(403);
    const cross = await app.inject({ method: 'GET', url: `/api/v1/schemes/${schemeId}/slabs`, headers: otherManager() });
    expect(cross.statusCode).toBe(403);
    const crossWrite = await app.inject({
      method: 'POST', url: `/api/v1/schemes/${schemeId}/slabs`, headers: otherManager(), payload: { slabs: [] },
    });
    expect(crossWrite.statusCode).toBe(403);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/schemes/00000000-0000-0000-0000-000000000000/payout', headers: ctx.auth('manager') });
    expect(missing.statusCode).toBe(404);
  });
});
