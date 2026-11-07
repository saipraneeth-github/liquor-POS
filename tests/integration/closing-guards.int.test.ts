import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

const close = (extra: Record<string, unknown> = {}) =>
  ctx.app.inject({
    method: 'POST', url: '/api/v1/closing', headers: ctx.auth('manager'),
    payload: { branchId: ctx.branchId, openingCash: '0.00', actualCashCounted: '0.00', ...extra },
  });

describe('daily closing guards', () => {
  it('refuses to close a business day that has not started yet', async () => {
    const res = await close({ businessDate: '2999-01-01' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/not started/);
  });

  it('a rejected future closing does not lock that date', async () => {
    await close({ businessDate: '2999-01-01' });
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/closing?branchId=${ctx.branchId}`, headers: ctx.auth('manager') });
    expect(list.json().some((c: { closingDate: string }) => c.closingDate.startsWith('2999'))).toBe(false);
  });

  it('a changed figure needs a written reason (422 without one)', async () => {
    const res = await close({ businessDate: '2020-01-02', cardSales: '100.00' });   // system computed 0.00 for that day
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/cardSales/);
    expect(res.json().error).toMatch(/note/i);
    const tooShort = await close({ businessDate: '2020-01-02', cardSales: '100.00', notes: 'ok' });
    expect(tooShort.statusCode).toBe(422);
  });

  it('a changed figure with a reason is saved, stamped with the variance, and audited', async () => {
    const res = await close({ businessDate: '2020-01-02', cardSales: '100.00', notes: 'EDC batch slip #482 settled by bank' });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.cardSales).toBe('100.00');
    expect(row.notes).toContain('EDC batch slip #482');
    expect(row.notes).toMatch(/cardSales: system 0\.00 -> submitted 100\.00/);

    const { db } = await import('../../src/db/client.js');
    const { auditLog } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'closing.override'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits[0].meta)).toContain('cardSales');
  });

  it('figures equal to the system need no reason', async () => {
    const res = await close({ businessDate: '2020-01-03', cardSales: '0.00', upiSales: '0.00', cashSales: '0.00', creditSales: '0.00' });
    expect(res.statusCode).toBe(201);
    expect(res.json().notes ?? '').not.toMatch(/overridden/);
  });

  it('closes today once, then answers 409 for a second attempt', async () => {
    const first = await close({ businessDate: businessDateOf() });
    expect(first.statusCode).toBe(201);
    const second = await close({ businessDate: businessDateOf() });
    expect(second.statusCode).toBe(409);
  });
});
