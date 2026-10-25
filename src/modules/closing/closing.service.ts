import { db } from '../../db/client.js';
import { bills, dailyClosings } from '../../db/schema.js';
import { eq, and, gte, lt, inArray, desc } from 'drizzle-orm';
import { reconcileDailyClosing, type CashFloatInput } from './closing.engine.js';
import { businessDateOf, businessDayBounds } from '../../lib/business-day.js';
import type { JwtPayload } from '../auth/auth.service.js';

export interface SubmitClosingInput {
  branchId: string;
  openingCash: string;
  actualCashCounted: string;
  cashWithdrawals?: string;
  notes?: string;
  businessDate?: string;   // YYYY-MM-DD; defaults to today
}

export async function performDailyClosing(input: SubmitClosingInput, user: JwtPayload) {
  // Only this branch's bills rung in on the business day being closed
  const businessDate = input.businessDate ?? businessDateOf();
  const { start, end } = businessDayBounds(businessDate);

  const dayBills = await db
    .select({
      id: bills.id,
      total: bills.total,
      taxAmount: bills.taxAmount,
      paymentMode: bills.paymentMode,
      status: bills.status,
    })
    .from(bills)
    .where(and(
      eq(bills.branchId, input.branchId),
      gte(bills.createdAt, start),
      lt(bills.createdAt, end),
    ));

  const cashFloat: CashFloatInput = {
    openingCash: input.openingCash,
    cashWithdrawals: input.cashWithdrawals,
  };

  const recon = reconcileDailyClosing(
    dayBills.map((b) => ({
      id: b.id,
      total: b.total,
      taxAmount: b.taxAmount,
      paymentMode: b.paymentMode ?? 'CASH',
      status: b.status,
    })),
    cashFloat,
    input.actualCashCounted,
  );

  const [closingRecord] = await db
    .insert(dailyClosings)
    .values({
      branchId: input.branchId,
      closedById: user.sub,
      closingDate: start,
      openingCash: recon.openingCash,
      cashSales: recon.cashSales,
      cardSales: recon.cardSales,
      upiSales: recon.upiSales,
      creditSales: recon.creditSales,
      grossSales: recon.grossSales,
      totalTax: recon.totalTax,
      cashWithdrawals: recon.cashWithdrawals,
      expectedCashInDrawer: recon.expectedCashInDrawer,
      actualCashCounted: recon.actualCashCounted,
      cashDiscrepancy: recon.cashDiscrepancy,
      isBalanced: recon.isBalanced,
      totalBillsCount: recon.totalBillsCount,
      paidBillsCount: recon.paidBillsCount,
      voidedBillsCount: recon.voidedBillsCount,
      notes: input.notes,
      status: 'CLOSED',
    })
    .returning();

  return { ...closingRecord, businessDate };
}

/** Closing history. `branchIds === 'ALL'` → every branch. */
export async function listDailyClosings(branchIds: string[] | 'ALL') {
  if (branchIds === 'ALL') {
    return db.select().from(dailyClosings).orderBy(desc(dailyClosings.createdAt));
  }
  if (branchIds.length === 0) return [];
  return db
    .select()
    .from(dailyClosings)
    .where(inArray(dailyClosings.branchId, branchIds))
    .orderBy(desc(dailyClosings.createdAt));
}
