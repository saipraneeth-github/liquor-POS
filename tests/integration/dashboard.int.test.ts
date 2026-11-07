import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { branchDashboard, ownerDashboard } from '../../src/modules/dashboard/dashboard.service.js';
import type { JwtPayload } from '../../src/modules/auth/auth.service.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

// A fixed clock: 21:12 IST on Saturday 7 Nov 2026. The store day starts at 18:30 UTC the evening before.
const NOW = new Date('2026-11-07T15:42:00Z');
const at = (iso: string) => new Date(iso);
let n = 0;

const inject = (url: string, headers: Record<string, string>) => ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers });

async function makeBranch(syndicateId: string | null, name: string) {
  const [b] = await ctx.db.insert(ctx.schema.branches).values({ name, code: `${name.slice(0, 3).toUpperCase()}${++n}${Math.floor(Math.random() * 99)}`, syndicateId }).returning();
  return b;
}
const asUser = (role: JwtPayload['role'], sub: string, branchId: string | null): JwtPayload => ({ sub, email: `${role}@t`, role, branchId, syndicateId: null });

/** The database allows one OPEN shift per cashier, so every test that opens a shift gets its own cashier. */
async function newCashier(branchId: string, name = 'Asha') {
  const [u] = await ctx.db.insert(ctx.schema.users).values({ name, email: `cash${++n}-${Math.random()}@test.local`, passwordHash: 'x', role: 'cashier', branchId }).returning();
  return u;
}

/** A PAID bill at a given instant, with its line item so "top sellers" has something to count. */
async function paidBill(branchId: string, createdAt: Date, mode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT', total: string, tax: string, opts: { productIdx?: number; qty?: number; shiftId?: string; cashierId?: string; status?: 'PAID' | 'VOIDED' } = {}) {
  const [b] = await ctx.db.insert(ctx.schema.bills).values({
    branchId, cashierId: opts.cashierId ?? ctx.users.cashier.id, billNumber: `D-${++n}-${Math.floor(Math.random() * 1e6)}`,
    status: opts.status ?? 'PAID', subtotal: total, taxAmount: tax, total, paymentMode: mode, createdAt, paidAt: createdAt, shiftSessionId: opts.shiftId ?? null,
  }).returning();
  const p = ctx.products[opts.productIdx ?? 0];
  await ctx.db.insert(ctx.schema.billItems).values({ billId: b.id, productId: p.id, quantity: opts.qty ?? 1, unitPrice: total, taxRate: '18.00', taxAmount: tax, lineTotal: total });
  return b;
}

// ── one outlet, with exact figures ────────────────────────────────────────────
describe('manager view of one outlet', () => {
  let branchId: string;
  beforeAll(async () => {
    const b = await makeBranch(ctx.syndicateId, 'Calc');
    branchId = b.id;
    // today (IST): 10:10 card 1,000 · 15:30 UPI 400 (2 beer) · 19:30 cash 1,000; plus a voided bill that must not count
    await paidBill(branchId, at('2026-11-07T04:40:00Z'), 'CARD', '1000.00', '152.54', { productIdx: 0 });
    await paidBill(branchId, at('2026-11-07T10:00:00Z'), 'UPI', '400.00', '42.86', { productIdx: 1, qty: 2 });
    await paidBill(branchId, at('2026-11-07T14:00:00Z'), 'CASH', '1000.00', '152.54', { productIdx: 0 });
    await paidBill(branchId, at('2026-11-07T14:10:00Z'), 'CASH', '9999.00', '1525.00', { status: 'VOIDED' });
    // yesterday: 1,000 before this time of day, 500 after it
    await paidBill(branchId, at('2026-11-06T04:40:00Z'), 'CASH', '1000.00', '152.54');
    await paidBill(branchId, at('2026-11-06T17:00:00Z'), 'CASH', '500.00', '76.27');
  });

  it("adds up today's paid bills in the database and ignores voided ones", async () => {
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, branchId), branchId, NOW);
    expect(d.businessDate).toBe('2026-11-07');
    expect(d.today).toMatchObject({ sales: '2400.00', bills: 3, averageBill: '800.00', gst: '347.94' });
  });

  it('splits by payment mode', async () => {
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, branchId), branchId, NOW);
    expect(d.today!.mix).toEqual([
      { mode: 'CASH', total: '1000.00', share: 41.7 }, { mode: 'UPI', total: '400.00', share: 16.7 },
      { mode: 'CARD', total: '1000.00', share: 41.7 }, { mode: 'CREDIT', total: '0.00', share: 0 },
    ]);
  });

  it('puts each bill in its store-day hour (IST), not its UTC hour', async () => {
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, branchId), branchId, NOW);
    const h = d.today!.hourly;
    expect(h).toHaveLength(24);
    expect(h[10]).toBe(1000);       // 10:10 IST
    expect(h[15]).toBe(400);        // 15:30 IST
    expect(h[19]).toBe(1000);       // 19:30 IST
    expect(h.reduce((a, b) => a + b, 0)).toBe(2400);
    expect(d.currentHour).toBe(21);
  });

  it('compares with yesterday AT THE SAME TIME, not with the whole of yesterday', async () => {
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, branchId), branchId, NOW);
    expect(d.today!.vsYesterday).toEqual({ sameTimeSales: '1000.00', percent: 140 });
    expect(d.yesterday!.sales).toBe('1500.00');
    expect(d.yesterday!.hourly.reduce((a, b) => a + b, 0)).toBe(1500);
  });

  it('ranks top sellers by sales, with units', async () => {
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, branchId), branchId, NOW);
    expect(d.topSellers).toEqual([
      { name: 'Test Whisky 750ml', units: 2, sales: '2000.00' },
      { name: 'Test Beer 650ml', units: 2, sales: '400.00' },
    ]);
  });

  it('shows nothing to compare with (null) when yesterday had no sales', async () => {
    const fresh = await makeBranch(ctx.syndicateId, 'Fresh');
    await paidBill(fresh.id, at('2026-11-07T10:00:00Z'), 'CASH', '300.00', '45.76');
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, fresh.id), fresh.id, NOW);
    expect(d.today!.vsYesterday.percent).toBeNull();
  });

  it('flags stock, an overnight shift and an unclosed yesterday, worst first; a closed yesterday is good news', async () => {
    const b = await makeBranch(ctx.syndicateId, 'Alerts');
    await paidBill(b.id, at('2026-11-06T09:00:00Z'), 'CASH', '800.00', '122.03');          // yesterday had sales…
    await ctx.db.insert(ctx.schema.stock).values([
      { branchId: b.id, productId: ctx.products[0].id, quantity: 0, reorderLevel: 5 },       // out of stock
      { branchId: b.id, productId: ctx.products[1].id, quantity: 3, reorderLevel: 5 },       // low
    ]);
    const [term] = await ctx.db.insert(ctx.schema.terminals).values({ branchId: b.id, terminalName: 'Counter 2', deviceKey: `dk-${++n}-${Math.random()}` }).returning();
    const ravi = await newCashier(b.id, 'Ravi');
    await ctx.db.insert(ctx.schema.shiftSessions).values({ branchId: b.id, terminalId: term.id, cashierId: ravi.id, openedAt: at('2026-11-06T09:00:00Z') });   // left open since yesterday

    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, b.id), b.id, NOW);
    expect(d.attention.map((a) => [a.id, a.severity])).toEqual([
      ['shift', 'bad'], ['yesterday-open', 'bad'], ['out-of-stock', 'bad'], ['low-stock', 'warn'],
    ]);
    expect(d.attention[0]).toMatchObject({ title: 'Counter 2 shift still open', route: '/shift' });
    expect(d.attention[0].detail).toContain('since yesterday');
    expect(d.lowStockCount).toBe(2);
    expect(d.closing!.steps[0]).toMatchObject({ id: 'shifts', done: false, label: 'Close 1 open shift' });

    // closing yesterday turns that item into good news
    await ctx.db.insert(ctx.schema.dailyClosings).values({
      branchId: b.id, closedById: ctx.users.manager.id, closingDate: at('2026-11-05T18:30:00Z'), openingCash: '0', cashSales: '800', cardSales: '0', upiSales: '0', creditSales: '0',
      grossSales: '800', totalTax: '122.03', cashWithdrawals: '0', expectedCashInDrawer: '800', actualCashCounted: '800', cashDiscrepancy: '0', isBalanced: true,
      totalBillsCount: 1, paidBillsCount: 1, voidedBillsCount: 0, status: 'CLOSED',
    });
    const after = await branchDashboard(asUser('manager', ctx.users.manager.id, b.id), b.id, NOW);
    expect(after.attention.map((a) => a.id)).toEqual(['shift', 'out-of-stock', 'low-stock', 'yesterday-ok']);
  });

  it('lists only the closing steps this outlet uses, and counts bank lines still to review', async () => {
    const b = await makeBranch(ctx.syndicateId, 'Steps');
    expect((await branchDashboard(asUser('manager', ctx.users.manager.id, b.id), b.id, NOW)).closing!.steps.map((s) => s.id)).toEqual(['shifts']);

    await ctx.db.insert(ctx.schema.dailyCounterSheets).values({ branchId: b.id, sheetDate: '2026-11-07', createdById: ctx.users.manager.id });
    const [acct] = await ctx.db.insert(ctx.schema.bankAccounts).values({ branchId: b.id, name: `Acct ${++n}` }).returning();
    const [st] = await ctx.db.insert(ctx.schema.bankStatements).values({ accountId: acct.id, fileHash: `h${++n}`, source: 'CSV', periodEnd: '2026-11-06' }).returning();
    await ctx.db.insert(ctx.schema.bankStatementLines).values([
      { statementId: st.id, accountId: acct.id, lineNo: 1, txnDate: '2026-11-06', narration: 'A', credit: '10', hash: `l${++n}` },
      { statementId: st.id, accountId: acct.id, lineNo: 2, txnDate: '2026-11-06', narration: 'B', debit: '5', hash: `l${++n}`, status: 'MATCHED' },
    ]);
    const d = await branchDashboard(asUser('manager', ctx.users.manager.id, b.id), b.id, NOW);
    expect(d.closing!.steps.map((s) => [s.id, s.done])).toEqual([['shifts', true], ['counter', false], ['bank', false]]);
    expect(d.attention.find((a) => a.id === 'bank')).toMatchObject({ title: '1 bank line to review', severity: 'warn', route: '/bank' });
  });
});

// ── the cashier's own view ────────────────────────────────────────────────────
describe('cashier view', () => {
  it('shows their own shift, what should be in the drawer, and their last bills, but never branch revenue or the books', async () => {
    const b = await makeBranch(ctx.syndicateId, 'Till');
    const me = await newCashier(b.id);
    const [term] = await ctx.db.insert(ctx.schema.terminals).values({ branchId: b.id, terminalName: 'Counter 1', deviceKey: `dk-${++n}-${Math.random()}` }).returning();
    const [shift] = await ctx.db.insert(ctx.schema.shiftSessions).values({
      branchId: b.id, terminalId: term.id, cashierId: me.id, openedAt: at('2026-11-07T04:30:00Z'), openingFloat: '2000.00',
    }).returning();
    await paidBill(b.id, at('2026-11-07T05:00:00Z'), 'CASH', '650.00', '99.15', { shiftId: shift.id, cashierId: me.id });
    await paidBill(b.id, at('2026-11-07T06:00:00Z'), 'UPI', '350.00', '53.39', { shiftId: shift.id, cashierId: me.id });
    await paidBill(b.id, at('2026-11-07T07:00:00Z'), 'CASH', '5000.00', '762.71', { cashierId: ctx.users.manager.id });     // someone else's sale

    const d = await branchDashboard(asUser('cashier', me.id, b.id), b.id, NOW);
    expect(d.role).toBe('cashier');
    expect(d.myShift).toMatchObject({ terminalName: 'Counter 1', openingFloat: '2000.00', sales: '1000.00', bills: 2, expectedCash: '2650.00' });
    expect(d.myRecentBills!.map((x) => x.total)).toEqual(['350.00', '650.00']);       // newest first, only mine
    expect(d).not.toHaveProperty('today');
    expect(d).not.toHaveProperty('topSellers');
    expect(d).not.toHaveProperty('closing');
    expect(JSON.stringify(d)).not.toContain('5000.00');
  });

  it('a shift open for a normal stretch is not a warning; one running very long is', async () => {
    const b = await makeBranch(ctx.syndicateId, 'Long');
    const [term] = await ctx.db.insert(ctx.schema.terminals).values({ branchId: b.id, terminalName: 'Counter 1', deviceKey: `dk-${++n}-${Math.random()}` }).returning();
    const me = await newCashier(b.id);
    const [shift] = await ctx.db.insert(ctx.schema.shiftSessions).values({ branchId: b.id, terminalId: term.id, cashierId: me.id, openedAt: at('2026-11-07T10:00:00Z') }).returning();
    expect((await branchDashboard(asUser('cashier', me.id, b.id), b.id, NOW)).attention.some((a) => a.id === 'shift')).toBe(false);   // 5 h 42 m
    await ctx.db.update(ctx.schema.shiftSessions).set({ openedAt: at('2026-11-07T03:00:00Z') }).where((await import('drizzle-orm')).eq(ctx.schema.shiftSessions.id, shift.id));
    const item = (await branchDashboard(asUser('cashier', me.id, b.id), b.id, NOW)).attention.find((a) => a.id === 'shift')!;
    expect(item).toMatchObject({ severity: 'warn', title: 'Your shift has been open 12 h 42 m' });
  });
});

// ── access ────────────────────────────────────────────────────────────────────
describe('who may open it', () => {
  it('a cashier and a manager get their views over HTTP; stewards and strangers do not', async () => {
    expect((await inject(`/dashboard/branch/${ctx.branchId}`, ctx.auth('manager'))).statusCode).toBe(200);
    expect((await inject(`/dashboard/branch/${ctx.branchId}`, ctx.auth('cashier'))).json().role).toBe('cashier');
    expect((await inject(`/dashboard/branch/${ctx.branchId}`, ctx.auth('steward'))).statusCode).toBe(403);
    expect((await inject(`/dashboard/branch/${ctx.branchId}`, {})).statusCode).toBe(401);
    expect((await inject('/dashboard/branch/not-a-uuid', ctx.auth('manager'))).statusCode).toBe(400);
  });

  it("another branch's manager cannot read this branch", async () => {
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await inject(`/dashboard/branch/${ctx.branchId}`, other)).statusCode).toBe(403);
    expect((await inject(`/dashboard/branch/${ctx.otherBranchId}`, other)).statusCode).toBe(200);
  });

  it('the all-outlets overview is for owners only', async () => {
    expect((await inject('/dashboard/owner', ctx.auth('manager'))).statusCode).toBe(403);
    expect((await inject('/dashboard/owner', ctx.auth('cashier'))).statusCode).toBe(403);
    expect((await inject('/dashboard/owner', ctx.auth('owner'))).statusCode).toBe(200);
  });

  it('a platform Super Admin is pointed to the Platform console instead of an owner overview', async () => {
    const [platform] = await ctx.db.insert(ctx.schema.users).values({ name: 'Platform', email: `plat${++n}@test.local`, passwordHash: 'x', role: 'owner', branchId: null, syndicateId: null }).returning();
    const res = await inject('/dashboard/owner', ctx.authFor({ sub: platform.id, email: platform.email, role: 'owner', branchId: null, syndicateId: null }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/Platform console/);
  });
});

// ── the owner's overview, in a business of its own so the totals are exact ────
describe('owner overview', () => {
  let owner: JwtPayload;
  let a: { id: string }; let b: { id: string };

  beforeAll(async () => {
    const [syn] = await ctx.db.insert(ctx.schema.syndicates).values({ name: 'Owner Co', maxBranches: 5 }).returning();
    a = await makeBranch(syn.id, 'Alpha');
    b = await makeBranch(syn.id, 'Bravo');
    const [o] = await ctx.db.insert(ctx.schema.users).values({ name: 'Anil', email: `own${++n}@test.local`, passwordHash: 'x', role: 'owner', branchId: null, syndicateId: syn.id }).returning();
    owner = { sub: o.id, email: o.email, role: 'owner', branchId: null, syndicateId: syn.id };

    // today and yesterday
    await paidBill(a.id, at('2026-11-07T04:40:00Z'), 'CARD', '1000.00', '152.54');
    await paidBill(a.id, at('2026-11-07T10:00:00Z'), 'UPI', '400.00', '42.86');
    await paidBill(a.id, at('2026-11-07T14:00:00Z'), 'CASH', '1000.00', '152.54');
    await paidBill(a.id, at('2026-11-06T04:40:00Z'), 'CASH', '1000.00', '152.54');
    await paidBill(a.id, at('2026-11-06T17:00:00Z'), 'CASH', '500.00', '76.27');
    await paidBill(b.id, at('2026-11-07T10:00:00Z'), 'UPI', '1000.00', '152.54');
    await paidBill(b.id, at('2026-11-06T04:40:00Z'), 'CASH', '1200.00', '183.05');
    // last month: 5,000 on 3 Oct (inside "the same days"), 3,000 on 20 Oct (only in the full month)
    await paidBill(a.id, at('2026-10-03T06:00:00Z'), 'CASH', '5000.00', '762.71');
    await paidBill(b.id, at('2026-10-20T06:00:00Z'), 'CASH', '3000.00', '457.63');

    // Alpha closed yesterday, Bravo did not; Alpha has a low-stock item and a stale bank statement
    await ctx.db.insert(ctx.schema.dailyClosings).values({
      branchId: a.id, closedById: ctx.users.manager.id, closingDate: at('2026-11-05T18:30:00Z'), openingCash: '0', cashSales: '1500', cardSales: '0', upiSales: '0', creditSales: '0',
      grossSales: '1500', totalTax: '228.81', cashWithdrawals: '0', expectedCashInDrawer: '1500', actualCashCounted: '1500', cashDiscrepancy: '0', isBalanced: true,
      totalBillsCount: 2, paidBillsCount: 2, voidedBillsCount: 0, status: 'CLOSED',
    });
    await ctx.db.insert(ctx.schema.stock).values({ branchId: a.id, productId: ctx.products[0].id, quantity: 0, reorderLevel: 5 });
    const [acct] = await ctx.db.insert(ctx.schema.bankAccounts).values({ branchId: a.id, name: `Alpha bank ${++n}` }).returning();
    await ctx.db.insert(ctx.schema.bankStatements).values({ accountId: acct.id, fileHash: `own${++n}`, source: 'CSV', periodEnd: '2026-10-20', status: 'RECONCILED' });

    // Khata: Alpha's customer owes 600 (bought 1000 / 500 / 300; repayments cleared the oldest), Bravo's owes 200 with no history
    const [c1] = await ctx.db.insert(ctx.schema.customers).values({ branchId: a.id, name: 'Ravi', phone: `9${++n}0000000`.slice(0, 10), creditAllowed: true, creditLimit: '5000', currentCredit: '600.00' }).returning();
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    for (const [amt, d] of [['1000.00', 80], ['500.00', 40], ['300.00', 10]] as const) {
      await ctx.db.insert(ctx.schema.creditTransactions).values({ customerId: c1.id, type: 'PURCHASE', amount: amt, balanceAfter: amt, recordedById: ctx.users.manager.id, recordedAt: day(d) });
    }
    await ctx.db.insert(ctx.schema.customers).values({ branchId: b.id, name: 'Sita', phone: `8${++n}0000000`.slice(0, 10), creditAllowed: true, creditLimit: '5000', currentCredit: '200.00' });
  });

  it('puts every outlet side by side, each against its own yesterday at this time', async () => {
    const d = await ownerDashboard(owner, NOW);
    const alpha = d.branches.find((x) => x.id === a.id)!;
    const bravo = d.branches.find((x) => x.id === b.id)!;
    expect(alpha).toMatchObject({ sales: '2400.00', bills: 3, salesSameTimeYesterday: '1000.00', percent: 140 });
    expect(bravo).toMatchObject({ sales: '1000.00', salesSameTimeYesterday: '1200.00', percent: -16.7 });
    expect(d.totals).toEqual({ sales: '3400.00', salesSameTimeYesterday: '2200.00', percent: 54.5, bills: 4 });
  });

  it('compares the month so far with the same days of last month and with all of last month', async () => {
    const m = (await ownerDashboard(owner, NOW)).month;
    expect(m.sales).toBe('6100.00');               // 2,400 + 1,500 + 1,000 + 1,200
    expect(m.sameDaysLastMonth).toBe('5000.00');
    expect(m.lastMonthTotal).toBe('8000.00');
    expect(m.percent).toBe(22);
    expect(m.percentOfLastMonth).toBe(76.3);
  });

  it('ages what customers owe, oldest repayments first, and calls out what is over 30 days', async () => {
    const k = (await ownerDashboard(owner, NOW)).khata;
    expect(k.owed).toBe('800.00');
    expect(k.customers).toBe(2);
    expect(k.buckets.map((x) => x.amount)).toEqual(['300.00', '0.00', '300.00', '200.00']);   // Ravi 300 new + 300 of the 40-day one; Bravo's undated 200
    expect(k.over30).toBe('500.00');
  });

  it('lists what needs the owner, by outlet, worst first', async () => {
    const d = await ownerDashboard(owner, NOW);
    expect(d.attention.map((x) => [x.severity, x.title])).toEqual([
      ['bad', 'Bravo: yesterday not closed'],
      ['warn', 'Alpha: no bank statement for 18 days'],
      ['warn', 'Alpha: 1 item low'],
    ]);
    expect(d.attention[0]).toMatchObject({ branchId: b.id, route: '/closing' });
    expect(d.bank).toEqual({ outlets: 1, reconciled: 1 });
  });

  it("an owner sees only their own business's outlets", async () => {
    const d = await ownerDashboard(owner, NOW);
    expect(d.branches.map((x) => x.name).sort()).toEqual(['Alpha', 'Bravo']);
    const main = await ownerDashboard({ sub: ctx.users.owner.id, email: 'o', role: 'owner', branchId: null, syndicateId: ctx.syndicateId }, NOW);
    expect(main.branches.some((x) => x.id === a.id)).toBe(false);
  });
});
