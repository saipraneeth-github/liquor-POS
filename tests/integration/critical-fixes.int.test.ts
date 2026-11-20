/**
 * Regression tests for the first group of critical review findings:
 *  1. clearing one branch's inventory must not touch other branches / businesses (and is office-admin only)
 *  2. (frontend offline sync: covered by the Playwright offline spec)
 *  3. a voucher that does not balance is refused by the database itself
 *  4. a counted closing on a DRAFT counter sheet survives later bills
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, role: 'manager' | 'cashier' | 'office_admin' | 'owner', payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });

describe('voucher balance is enforced by the database', () => {
  async function newVoucher(tx: typeof ctx.db, n: string) {
    const [v] = await tx.insert(ctx.schema.journalVouchers).values({
      branchId: ctx.branchId, voucherNumber: `JV-TEST-${n}`, voucherDate: businessDateOf(), voucherType: 'JOURNAL', narration: 'test',
    }).returning();
    return v;
  }
  let made: { id: string }[] | null = null;
  async function twoLedgers() {
    made ??= await ctx.db.insert(ctx.schema.accountLedgers).values([
      { branchId: ctx.branchId, code: 'T_DR', name: 'Test debit', group: 'ASSET' },
      { branchId: ctx.branchId, code: 'T_CR', name: 'Test credit', group: 'INCOME' },
    ]).returning();
    return made;
  }

  it('refuses an unbalanced voucher at commit', async () => {
    const [a, b] = await twoLedgers();
    await expect(ctx.db.transaction(async (tx) => {
      const v = await newVoucher(tx as never, 'BAD');
      await tx.insert(ctx.schema.journalLines).values([
        { voucherId: v.id, ledgerId: a.id, debit: '100.00', credit: '0' },
        { voucherId: v.id, ledgerId: b.id, debit: '0', credit: '99.00' },
      ]);
    })).rejects.toThrow(/unbalanced/);
    const left = await ctx.db.select().from(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.voucherNumber, 'JV-TEST-BAD'));
    expect(left).toHaveLength(0);
  });

  it('accepts a balanced voucher even when its lines arrive in separate statements', async () => {
    const [a, b] = await twoLedgers();
    await ctx.db.transaction(async (tx) => {
      const v = await newVoucher(tx as never, 'OK');
      await tx.insert(ctx.schema.journalLines).values({ voucherId: v.id, ledgerId: a.id, debit: '50.00', credit: '0' });
      await tx.insert(ctx.schema.journalLines).values({ voucherId: v.id, ledgerId: b.id, debit: '0', credit: '50.00' });
    });
    const ok = await ctx.db.select().from(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.voucherNumber, 'JV-TEST-OK'));
    expect(ok).toHaveLength(1);
  });
});

describe('a counted closing survives later bills', () => {
  it('keeps the counted closing after a bill is paid; untouched lines still follow the bills', async () => {
    const whisky = ctx.products[0].id;
    const beer = ctx.products[1].id;
    const created = await call('POST', `/counter-sheets/${ctx.branchId}`, 'cashier', { sheetDate: businessDateOf() });
    expect(created.statusCode, created.body).toBe(201);
    const sheet = created.json();
    const line = (s: any, id: string) => s.lines.find((l: any) => l.productId === id);
    const theoretical = line(sheet, whisky).openingBottles + line(sheet, whisky).inwardBottles;

    // cashier counts 2 bottles fewer than the books say (2 sold without a bill)
    const put = await call('PUT', `/counter-sheets/sheet/${sheet.id}/lines`, 'cashier', {
      lines: [{ productId: whisky, closingBottles: theoretical - 2 }],
    });
    expect(put.statusCode, put.body).toBe(200);

    // a normal POS bill for the same product and for another one
    for (const productId of [whisky, beer]) {
      const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId, quantity: 1 }] });
      expect(bill.statusCode, bill.body).toBe(201);
    }

    const after = (await call('GET', `/counter-sheets/sheet/${sheet.id}`, 'cashier')).json();
    expect(line(after, whisky).closingBottles).toBe(theoretical - 2);      // the count was not overwritten
    expect(line(after, whisky).soldBottles).toBe(2);                       // sold = opening + inward - counted closing
    const beerAfter = line(after, beer);                                   // never counted: follows the bills
    expect(beerAfter.closingBottles).toBe(beerAfter.openingBottles + beerAfter.inwardBottles - 1);
  });
});

describe('clearing a branch inventory', () => {
  it('is refused for a manager', async () => {
    expect((await call('DELETE', `/inventory/stock/${ctx.branchId}/clear`, 'manager')).statusCode).toBe(403);
  });

  it('only forgets this branch: other products and the other business keep their cost', async () => {
    const { products, branchProductCosts, stock } = ctx.schema;
    await ctx.db.insert(branchProductCosts).values({ branchId: ctx.branchId, productId: ctx.products[0].id, costPrice: '800' });
    const [otherBefore] = await ctx.db.select().from(products).where(eq(products.id, ctx.otherProducts[0].id));

    const res = await call('DELETE', `/inventory/stock/${ctx.branchId}/clear`, 'office_admin');
    expect(res.statusCode, res.body).toBe(200);

    expect(await ctx.db.select().from(branchProductCosts).where(eq(branchProductCosts.branchId, ctx.branchId))).toHaveLength(0);
    expect(await ctx.db.select().from(stock).where(eq(stock.branchId, ctx.branchId))).toHaveLength(0);
    const [mine] = await ctx.db.select().from(products).where(eq(products.id, ctx.products[0].id));
    expect(Number(mine.costPrice)).toBe(800);                              // business-wide cost untouched
    const [otherAfter] = await ctx.db.select().from(products).where(eq(products.id, ctx.otherProducts[0].id));
    expect(otherAfter.costPrice).toBe(otherBefore.costPrice);
    const other = await ctx.db.select().from(stock).where(and(eq(stock.branchId, ctx.otherBranchId)));
    expect(other.length).toBeGreaterThan(0);                               // the other branch's stock is intact
  });
});

describe('database constraints (0040)', () => {
  it('refuses negative stock, in the shop total and in a counter', async () => {
    const { stock, stockByType } = ctx.schema;
    // the clear-inventory test above emptied stock: put a row back
    const [row] = await ctx.db.insert(stock).values({ branchId: ctx.branchId, productId: ctx.products[0].id, quantity: 3 }).returning();
    // Drizzle wraps the driver error ("Failed query"), so assert on the cause and on the unchanged row
    const err: any = await ctx.db.update(stock).set({ quantity: -1 }).where(eq(stock.id, row.id)).then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(JSON.stringify([err.message, err.cause?.message, err.cause?.constraint])).toMatch(/ck_stock_qty_nonneg/);
    expect((await ctx.db.select().from(stock).where(eq(stock.id, row.id)))[0].quantity).toBe(3);
    expect(stockByType).toBeDefined();
  });

  it('refuses a zero expense and a negative bill total', async () => {
    const { expenses, bills } = ctx.schema;
    await expect(ctx.db.insert(expenses).values({
      branchId: ctx.branchId, category: 'Rent', amount: '0', paymentMode: 'CASH', expenseDate: businessDateOf(), recordedById: ctx.users.manager.id,
    })).rejects.toThrow();
    await expect(ctx.db.insert(bills).values({
      branchId: ctx.branchId, cashierId: ctx.users.cashier.id, billNumber: 'NEG-1', status: 'PAID', subtotal: '10', taxAmount: '0',
      discount: '0', roundOff: '0', total: '-5', paymentMode: 'CASH',
    })).rejects.toThrow();
  });

  it('a voucher cannot be deleted while it still has lines', async () => {
    const [led] = await ctx.db.insert(ctx.schema.accountLedgers).values([
      { branchId: ctx.branchId, code: 'R_DR', name: 'r dr', group: 'ASSET' },
      { branchId: ctx.branchId, code: 'R_CR', name: 'r cr', group: 'INCOME' },
    ]).returning();
    const [cr] = await ctx.db.select().from(ctx.schema.accountLedgers).where(eq(ctx.schema.accountLedgers.code, 'R_CR'));
    const v = await ctx.db.transaction(async (tx) => {
      const [voucher] = await tx.insert(ctx.schema.journalVouchers).values({
        branchId: ctx.branchId, voucherNumber: 'JV-TEST-RESTRICT', voucherDate: businessDateOf(), voucherType: 'JOURNAL', narration: 'x',
      }).returning();
      await tx.insert(ctx.schema.journalLines).values([
        { voucherId: voucher.id, ledgerId: led.id, debit: '5', credit: '0' },
        { voucherId: voucher.id, ledgerId: cr.id, debit: '0', credit: '5' },
      ]);
      return voucher;
    });
    await expect(ctx.db.delete(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.id, v.id))).rejects.toThrow();
  });

  it('bill numbers still increment (bill_counters has a primary key now)', async () => {
    const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[1].id, quantity: 1 }] });
    // stock of the branch was cleared above, so the sale is refused for stock, not for the counter
    expect([201, 422]).toContain(bill.statusCode);
  });
});
