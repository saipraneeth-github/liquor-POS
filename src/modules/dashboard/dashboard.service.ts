/**
 * dashboard.service.ts — the numbers behind the landing page, aggregated in the database (never "the first 50 bills").
 *   branchDashboard: one outlet. A cashier gets their own shift and stock only; managers/owners get the day's money.
 *   ownerDashboard : every outlet of the owner's business side by side, month comparison, khata ageing, pending items.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import {
  bankAccounts, bankStatementLines, bankStatements, billItems, bills, branches, creditTransactions, customers, dailyClosings,
  dailyCounterSheets, dailyCounterSheetLines, pourCounts, products, shiftSessions, stock, tableSessions, tables, terminals, users,
} from '../../db/schema.js';
import { businessDateOf, businessDayBounds } from '../../lib/business-day.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { getAccessibleBranchIds } from '../../middleware/auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import {
  attentionItems, closingSteps, hourlyBuckets, khataAging, mergeAging, minutesBetween, monthStartOf, pastMonthsList, paymentMix, percentChange,
  previousMonthStart, sameTimeYesterday, sumTotals, type AttentionItem, type PayMode,
} from './dashboard.engine.js';

const D = (v: Decimal.Value) => new Decimal(v);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

function addDaysIso(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

const paidIn = (branchFilter: ReturnType<typeof eq> | ReturnType<typeof inArray>, from: Date, to: Date) =>
  and(branchFilter, eq(bills.status, 'PAID'), gte(bills.createdAt, from), lt(bills.createdAt, to));

// ─── ONE OUTLET ─────────────────────────────────────────────────────────────

export async function branchDashboard(user: JwtPayload, branchId: string, now: Date = new Date()) {
  // An office admin runs the business for the owner, so they get the owner's view (a manager's or above)
  const role: 'cashier' | 'manager' | 'owner' = user.role === 'owner' || user.role === 'office_admin' ? 'owner' : user.role === 'manager' ? 'manager' : 'cashier';
  const staff = role !== 'cashier';

  const today = businessDateOf(now);
  const { start: dayStart, end: dayEnd } = businessDayBounds(today);
  const yesterday = addDaysIso(today, -1);
  const { start: yStart, end: yEnd } = businessDayBounds(yesterday);
  const yCutoff = sameTimeYesterday(dayStart, now, yStart);

  const [openShiftRows, lowRows, myShiftRow, yesterdayBills, yesterdayClosing] = await Promise.all([
    db.select({
      id: shiftSessions.id, openedAt: shiftSessions.openedAt, cashierId: shiftSessions.cashierId,
      terminalName: terminals.terminalName, cashierName: users.name,
    }).from(shiftSessions)
      .innerJoin(terminals, eq(shiftSessions.terminalId, terminals.id))
      .innerJoin(users, eq(shiftSessions.cashierId, users.id))
      .where(and(eq(shiftSessions.branchId, branchId), eq(shiftSessions.status, 'OPEN'))),
    db.select({ name: products.name, quantity: stock.quantity, reorderLevel: stock.reorderLevel })
      .from(stock).innerJoin(products, eq(stock.productId, products.id))
      .where(and(eq(stock.branchId, branchId), sql`${stock.quantity} <= coalesce(${stock.reorderLevel}, 0)`))
      .orderBy(asc(stock.quantity), asc(products.name)).limit(200),
    db.select().from(shiftSessions)
      .where(and(eq(shiftSessions.branchId, branchId), eq(shiftSessions.cashierId, user.sub), eq(shiftSessions.status, 'OPEN'))).limit(1),
    staff
      ? db.select({ at: bills.createdAt, total: bills.total }).from(bills).where(paidIn(eq(bills.branchId, branchId), yStart, yEnd))
      : Promise.resolve([] as Array<{ at: Date | null; total: string }>),
    staff
      ? db.select({ diff: dailyClosings.cashDiscrepancy }).from(dailyClosings)
          .where(and(eq(dailyClosings.branchId, branchId), gte(dailyClosings.closingDate, yStart), lt(dailyClosings.closingDate, yEnd))).limit(1)
      : Promise.resolve([] as Array<{ diff: string }>),
  ]);

  // My shift: what I have taken since opening, and what should be in my drawer
  let myShift: null | { id: string; terminalName: string; openedAt: string; openingFloat: string; sales: string; bills: number; expectedCash: string; mix: ReturnType<typeof paymentMix> } = null;
  if (myShiftRow[0]) {
    const s = myShiftRow[0];
    const sold = await db.select({ mode: bills.paymentMode, total: bills.total }).from(bills)
      .where(and(eq(bills.shiftSessionId, s.id), eq(bills.status, 'PAID')));
    const mix = paymentMix(sold.map((b) => ({ mode: b.mode, total: b.total })));
    const cash = D(mix.find((m) => m.mode === 'CASH')?.total ?? 0);
    myShift = {
      id: s.id,
      terminalName: openShiftRows.find((o) => o.id === s.id)?.terminalName ?? '',
      openedAt: (s.openedAt ?? now).toISOString(),
      openingFloat: money2(D(s.openingFloat)),
      sales: sumTotals(sold),
      bills: sold.length,
      expectedCash: money2(D(s.openingFloat).plus(cash)),
      mix,
    };
  }

  const lowStockCount = lowRows.length;
  const openShifts = openShiftRows.map((s) => ({
    terminalName: s.terminalName, cashierName: s.cashierName, openedAt: s.openedAt ?? now, mine: s.cashierId === user.sub,
  }));

  // ── a cashier gets their own shift and the stock list: no branch revenue, books or accounts ──
  if (!staff) {
    const mine = await db.select({
      id: bills.id, billNumber: bills.billNumber, createdAt: bills.createdAt, status: bills.status, total: bills.total, paymentMode: bills.paymentMode,
    }).from(bills)
      .where(and(eq(bills.branchId, branchId), eq(bills.cashierId, user.sub), gte(bills.createdAt, dayStart), lt(bills.createdAt, dayEnd)))
      .orderBy(desc(bills.createdAt)).limit(5);
    return {
      role, businessDate: today, generatedAt: now.toISOString(), myShift, myRecentBills: mine.map((b) => ({ ...b, createdAt: (b.createdAt ?? now).toISOString() })),
      attention: attentionItems({
        now, dayStart, role, openShifts, yesterdayHadSales: false, yesterdayClosed: false, yesterdayDifference: null, bankLinesToReview: 0,
        lowStock: lowRows.map((r) => ({ name: r.name, quantity: r.quantity })),
      }),
      lowStock: lowRows.slice(0, 6), lowStockCount,
    };
  }

  // ── managers and owners ──
  const [todayBills, tableRows, oldestSession, bankLines, accounts, sheets, pour, top, closedToday] = await Promise.all([
    db.select({ at: bills.createdAt, total: bills.total, mode: bills.paymentMode, tax: bills.taxAmount }).from(bills).where(paidIn(eq(bills.branchId, branchId), dayStart, dayEnd)),
    db.select({ status: tables.status, n: sql<number>`count(*)::int` }).from(tables).where(eq(tables.branchId, branchId)).groupBy(tables.status),
    db.select({ openedAt: sql<Date | null>`min(${tableSessions.openedAt})` }).from(tableSessions).where(and(eq(tableSessions.branchId, branchId), sql`${tableSessions.closedAt} is null`)),
    db.select({ n: sql<number>`count(*)::int` }).from(bankStatementLines)
      .innerJoin(bankAccounts, eq(bankStatementLines.accountId, bankAccounts.id))
      .where(and(eq(bankAccounts.branchId, branchId), inArray(bankStatementLines.status, ['UNMATCHED', 'SUGGESTED']))),
    db.select({ id: bankAccounts.id }).from(bankAccounts).where(and(eq(bankAccounts.branchId, branchId), eq(bankAccounts.isActive, true))).limit(1),
    db.select({ date: dailyCounterSheets.sheetDate, status: dailyCounterSheets.status }).from(dailyCounterSheets)
      .where(and(eq(dailyCounterSheets.branchId, branchId), gte(dailyCounterSheets.sheetDate, addDaysIso(today, -7)))),
    db.select({ at: pourCounts.createdAt }).from(pourCounts).where(and(eq(pourCounts.branchId, branchId), gte(pourCounts.createdAt, new Date(dayStart.getTime() - 7 * 86_400_000)))),
    db.select({ name: products.name, units: sql<number>`sum(${billItems.quantity})::int`, sales: sql<string>`sum(${billItems.lineTotal})` })
      .from(billItems).innerJoin(bills, eq(billItems.billId, bills.id)).innerJoin(products, eq(billItems.productId, products.id))
      .where(paidIn(eq(bills.branchId, branchId), dayStart, dayEnd))
      .groupBy(products.id, products.name).orderBy(desc(sql`sum(${billItems.lineTotal})`)).limit(5),
    db.select({ id: dailyClosings.id }).from(dailyClosings)
      .where(and(eq(dailyClosings.branchId, branchId), gte(dailyClosings.closingDate, dayStart), lt(dailyClosings.closingDate, dayEnd))).limit(1),
  ]);

  const todayRows = todayBills.map((b) => ({ at: b.at ?? now, total: b.total }));
  const salesToday = sumTotals(todayRows);
  const sameTimeSales = sumTotals(yesterdayBills.filter((b) => (b.at ?? now) < yCutoff));
  const gst = money2(todayBills.reduce((a, b) => a.plus(b.tax), D(0)));
  const bankToReview = bankLines[0]?.n ?? 0;

  const sheetToday = sheets.find((s) => s.date === today);
  const todayHour = Math.min(23, Math.max(0, Math.floor((now.getTime() - dayStart.getTime()) / 3_600_000)));
  const occupied = tableRows.find((t) => t.status === 'OCCUPIED')?.n ?? 0;
  const tableTotal = tableRows.reduce((a, t) => a + t.n, 0);

  return {
    role, businessDate: today, generatedAt: now.toISOString(), currentHour: todayHour,
    today: {
      sales: salesToday,
      bills: todayBills.length,
      averageBill: todayBills.length ? money2(D(salesToday).div(todayBills.length)) : '0.00',
      gst,
      hourly: hourlyBuckets(todayRows, dayStart),
      mix: paymentMix(todayBills.map((b) => ({ mode: b.mode, total: b.total }))),
      vsYesterday: { sameTimeSales: sameTimeSales, percent: percentChange(salesToday, sameTimeSales) },
    },
    yesterday: { sales: sumTotals(yesterdayBills), hourly: hourlyBuckets(yesterdayBills.map((b) => ({ at: b.at ?? now, total: b.total })), yStart) },
    tables: { occupied, total: tableTotal, oldestOpenMinutes: oldestSession[0]?.openedAt ? minutesBetween(new Date(oldestSession[0].openedAt), now) : null },
    myShift,
    attention: attentionItems({
      now, dayStart, role, openShifts,
      yesterdayHadSales: yesterdayBills.length > 0, yesterdayClosed: yesterdayClosing.length > 0, yesterdayDifference: yesterdayClosing[0]?.diff ?? null,
      bankLinesToReview: bankToReview, lowStock: lowRows.map((r) => ({ name: r.name, quantity: r.quantity })),
    }),
    closing: {
      closedToday: closedToday.length > 0,
      steps: closingSteps({
        openShiftCount: openShiftRows.length,
        counterSheetInUse: sheets.length > 0, counterSheetPosted: sheetToday?.status === 'POSTED',
        bankInUse: accounts.length > 0, bankLinesToReview: bankToReview,
        pourInUse: pour.length > 0, pourRecordedToday: pour.some((p) => (p.at ?? now) >= dayStart),
      }),
    },
    topSellers: top.map((t) => ({ name: t.name, units: t.units, sales: money2(D(t.sales)) })),
    lowStock: lowRows.slice(0, 6), lowStockCount,
  };
}

// ─── ALL OUTLETS (owner) ────────────────────────────────────────────────────

export async function ownerDashboard(user: JwtPayload, now: Date = new Date()) {
  const accessible = await getAccessibleBranchIds(user);
  if (accessible === 'ALL') throw new BusinessRuleError('This overview is for a business owner. Super Admins use the Platform console.');
  if (accessible.length === 0) throw new BusinessRuleError('No outlets are linked to this account yet.');

  const today = businessDateOf(now);
  const { start: dayStart, end: dayEnd } = businessDayBounds(today);
  const yesterday = addDaysIso(today, -1);
  const { start: yStart, end: yEnd } = businessDayBounds(yesterday);
  const yCutoff = sameTimeYesterday(dayStart, now, yStart);
  const monthStart = businessDayBounds(monthStartOf(today)).start;
  const prevStart = businessDayBounds(previousMonthStart(today)).start;
  const elapsed = now.getTime() - monthStart.getTime();
  const prevSameEnd = new Date(Math.min(prevStart.getTime() + elapsed, monthStart.getTime()));   // a shorter last month cannot overrun

  const inBranches = inArray(bills.branchId, accessible);
  const grouped = (from: Date, to: Date) => db.select({
    branchId: bills.branchId, total: sql<string>`coalesce(sum(${bills.total}), 0)`, n: sql<number>`count(*)::int`,
  }).from(bills).where(paidIn(inBranches, from, to)).groupBy(bills.branchId);
  const oneTotal = async (from: Date, to: Date) => {
    const [r] = await db.select({ total: sql<string>`coalesce(sum(${bills.total}), 0)` }).from(bills).where(paidIn(inBranches, from, to));
    return D(r?.total ?? 0);
  };

  const pastMonths = pastMonthsList(today, 6);
  const monthlyHistoryPromise = Promise.all(
    pastMonths.map(async (pm, idx) => {
      const { start: mStart } = businessDayBounds(pm.start);
      const mEnd = idx === pastMonths.length - 1 ? new Date(now.getTime() + 1) : businessDayBounds(pm.end).start;
      const total = await oneTotal(mStart, mEnd);
      return { month: pm.key, label: pm.label, sales: money2(total) };
    })
  );

  const [branchRows, todayBy, ySameBy, yBy, mtd, prevSame, prevFull, owing, lowBy, closings, bankLinesBy, accountRows, sheetsToday, billBottlesToday, stockTotals, monthlyHistory] = await Promise.all([
    db.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches).where(inArray(branches.id, accessible)).orderBy(asc(branches.name)),
    grouped(dayStart, dayEnd), grouped(yStart, yCutoff), grouped(yStart, yEnd),
    oneTotal(monthStart, new Date(now.getTime() + 1)), oneTotal(prevStart, prevSameEnd), oneTotal(prevStart, monthStart),
    db.select({ id: customers.id, branchId: customers.branchId, balance: customers.currentCredit }).from(customers)
      .where(and(inArray(customers.branchId, accessible), sql`${customers.currentCredit} > 0`)),
    db.select({ branchId: stock.branchId, n: sql<number>`count(*)::int` }).from(stock)
      .where(and(inArray(stock.branchId, accessible), sql`${stock.quantity} <= coalesce(${stock.reorderLevel}, 0)`)).groupBy(stock.branchId),
    db.select({ branchId: dailyClosings.branchId }).from(dailyClosings)
      .where(and(inArray(dailyClosings.branchId, accessible), gte(dailyClosings.closingDate, yStart), lt(dailyClosings.closingDate, yEnd))),
    db.select({ branchId: bankAccounts.branchId, n: sql<number>`count(*)::int` }).from(bankStatementLines)
      .innerJoin(bankAccounts, eq(bankStatementLines.accountId, bankAccounts.id))
      .where(and(inArray(bankAccounts.branchId, accessible), inArray(bankStatementLines.status, ['UNMATCHED', 'SUGGESTED']))).groupBy(bankAccounts.branchId),
    db.select({ id: bankAccounts.id, branchId: bankAccounts.branchId }).from(bankAccounts).where(and(inArray(bankAccounts.branchId, accessible), eq(bankAccounts.isActive, true))),
    db.select({
      branchId: dailyCounterSheets.branchId,
      totalRevenue: dailyCounterSheets.totalRevenue,
      soldBottles: sql<number>`coalesce(sum(${dailyCounterSheetLines.soldBottles}), 0)::int`,
      closingBottles: sql<number>`coalesce(sum(${dailyCounterSheetLines.closingBottles}), 0)::int`,
    })
      .from(dailyCounterSheets)
      .leftJoin(dailyCounterSheetLines, eq(dailyCounterSheets.id, dailyCounterSheetLines.sheetId))
      .where(and(inArray(dailyCounterSheets.branchId, accessible), eq(dailyCounterSheets.sheetDate, today)))
      .groupBy(dailyCounterSheets.id, dailyCounterSheets.branchId, dailyCounterSheets.totalRevenue),
    db.select({ n: sql<number>`coalesce(sum(${billItems.quantity}), 0)::int` })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .where(paidIn(inBranches, dayStart, dayEnd)),
    db.select({ n: sql<number>`coalesce(sum(${stock.quantity}), 0)::int` })
      .from(stock)
      .where(inArray(stock.branchId, accessible)),
    monthlyHistoryPromise,
  ]);

  const sheetRevTotal = sheetsToday.reduce((acc, s) => acc.plus(s.totalRevenue || 0), D(0));
  const sheetSoldTotal = sheetsToday.reduce((acc, s) => acc + (s.soldBottles || 0), 0);
  const sheetClosingTotal = sheetsToday.reduce((acc, s) => acc + (s.closingBottles || 0), 0);

  // Khata ageing across every customer who still owes money
  const owingIds = owing.map((c) => c.id);
  const purchases = owingIds.length === 0 ? [] : await db.select({ customerId: creditTransactions.customerId, amount: creditTransactions.amount, at: creditTransactions.recordedAt })
    .from(creditTransactions).where(and(inArray(creditTransactions.customerId, owingIds), eq(creditTransactions.type, 'PURCHASE')));
  const byCustomer = new Map<string, Array<{ amount: string; at: Date }>>();
  for (const p of purchases) byCustomer.set(p.customerId, [...(byCustomer.get(p.customerId) ?? []), { amount: p.amount, at: p.at ?? now }]);
  const aging = mergeAging(owing.map((c) => khataAging(byCustomer.get(c.id) ?? [], c.balance, now)));
  const owed = money2(owing.reduce((a, c) => a.plus(c.balance), D(0)));
  const over30 = money2(D(aging.find((b) => b.key === 'D31_60')?.amount ?? 0).plus(aging.find((b) => b.key === 'D60_PLUS')?.amount ?? 0));

  // Latest bank statement per outlet: how stale, and is it reconciled
  const statements = accountRows.length === 0 ? [] : await db.select({ accountId: bankStatements.accountId, periodEnd: bankStatements.periodEnd, status: bankStatements.status })
    .from(bankStatements).where(inArray(bankStatements.accountId, accountRows.map((a) => a.id))).orderBy(desc(bankStatements.periodEnd));
  const bankBy = new Map<string, { latestEnd: string | null; reconciled: boolean }>();
  for (const a of accountRows) {
    const mine = statements.filter((s) => s.accountId === a.id);
    const cur = bankBy.get(a.branchId);
    const latest = mine[0];
    const latestEnd = latest?.periodEnd ?? null;
    const pendingCount = bankLinesBy.find((l) => l.branchId === a.branchId)?.n ?? 0;
    const isReconciled = latest?.status === 'RECONCILED' && pendingCount === 0;
    if (!cur) bankBy.set(a.branchId, { latestEnd, reconciled: isReconciled });
    else bankBy.set(a.branchId, { latestEnd: latestEnd && (!cur.latestEnd || latestEnd > cur.latestEnd) ? latestEnd : cur.latestEnd, reconciled: cur.reconciled && isReconciled });
  }

  const num = (rows: Array<{ branchId: string; total: string; n: number }>, id: string) => rows.find((r) => r.branchId === id);
  const rows = branchRows.map((b) => {
    const t = num(todayBy, b.id);
    const sales = money2(D(t?.total ?? 0));
    const same = money2(D(num(ySameBy, b.id)?.total ?? 0));
    const yTotal = num(yBy, b.id);
    return {
      id: b.id, name: b.name, code: b.code, sales, bills: t?.n ?? 0, salesSameTimeYesterday: same, percent: percentChange(sales, same),
      lowStock: lowBy.find((l) => l.branchId === b.id)?.n ?? 0,
      bankToReview: bankLinesBy.find((l) => l.branchId === b.id)?.n ?? 0,
      yesterdayHadSales: (yTotal?.n ?? 0) > 0,
      yesterdayClosed: closings.some((c) => c.branchId === b.id),
      bank: bankBy.get(b.id) ?? null,
    };
  });

  const totalToday = rows.reduce((a, r) => a.plus(r.sales), D(0));
  const totalSame = rows.reduce((a, r) => a.plus(r.salesSameTimeYesterday), D(0));

  const finalSheetRevenue = sheetRevTotal.gt(0) ? money2(sheetRevTotal) : money2(totalToday);
  const finalBottlesSold = sheetSoldTotal > 0 ? sheetSoldTotal : (billBottlesToday[0]?.n ?? 0);
  const finalPhysicalStock = sheetClosingTotal > 0 ? sheetClosingTotal : (stockTotals[0]?.n ?? 0);

  // What needs the owner's eye, per outlet, most urgent first
  const STALE_DAYS = 10;
  const items: Array<AttentionItem & { branchId: string; branchName: string }> = [];
  for (const r of rows) {
    const add = (it: AttentionItem) => items.push({ ...it, id: `${it.id}:${r.id}`, branchId: r.id, branchName: r.name });
    if (r.yesterdayHadSales && !r.yesterdayClosed) add({ id: 'yesterday-open', severity: 'bad', title: `${r.name}: yesterday not closed`, detail: 'cash was not counted', route: '/closing' });
    if (r.bank) {
      const days = r.bank.latestEnd ? Math.floor((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${r.bank.latestEnd}T00:00:00Z`).getTime()) / 86_400_000) : null;
      if (days === null) add({ id: 'bank-none', severity: 'warn', title: `${r.name}: no bank statement uploaded yet`, detail: 'upload one to reconcile', route: '/bank' });
      else if (days > STALE_DAYS) add({ id: 'bank-stale', severity: 'warn', title: `${r.name}: no bank statement for ${days} days`, detail: 'upload the latest', route: '/bank' });
    }
    if (r.bankToReview > 0) add({ id: 'bank-review', severity: 'warn', title: `${r.name}: ${r.bankToReview} bank line${r.bankToReview === 1 ? '' : 's'} to review`, detail: 'match or post them', route: '/bank' });
    if (r.lowStock > 0) add({ id: 'low-stock', severity: 'warn', title: `${r.name}: ${r.lowStock} item${r.lowStock === 1 ? '' : 's'} low`, detail: 'reorder', route: '/inventory' });
  }
  const rank = { bad: 0, warn: 1, good: 2 } as const;
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const withBank = rows.filter((r) => r.bank);
  return {
    businessDate: today, generatedAt: now.toISOString(),
    branches: rows.map(({ yesterdayHadSales, yesterdayClosed, bank, ...r }) => { void yesterdayHadSales; void yesterdayClosed; void bank; return r; }),
    totals: {
      sales: money2(totalToday),
      salesSameTimeYesterday: money2(totalSame),
      percent: percentChange(totalToday, totalSame),
      bills: rows.reduce((a, r) => a + r.bills, 0),
      sheetRevenue: finalSheetRevenue,
      totalBottlesSold: finalBottlesSold,
      physicalStockPresent: finalPhysicalStock,
    },
    month: {
      sales: money2(mtd), sameDaysLastMonth: money2(prevSame), lastMonthTotal: money2(prevFull),
      percent: percentChange(mtd, prevSame), percentOfLastMonth: prevFull.isZero() ? null : Math.round(mtd.div(prevFull).mul(1000).toNumber()) / 10,
      history: monthlyHistory,
    },
    khata: { owed, over30, customers: owing.length, buckets: aging },
    bank: { outlets: withBank.length, reconciled: withBank.filter((r) => r.bank?.reconciled).length },
    attention: items,
  };
}
