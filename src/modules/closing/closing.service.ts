import { db } from '../../db/client.js';
import { bills, dailyClosings } from '../../db/schema.js';
import { eq, and, gte, lte } from 'drizzle-orm';
import { reconcileDailyClosing, type CashFloatInput } from './closing.engine.js';
import type { JwtPayload } from '../auth/auth.service.js';

export interface SubmitClosingInput {
  branchId: string;
  openingCash: string;
  actualCashCounted: string;
  cashWithdrawals?: string;
  notes?: string;
  startDate?: string;
  endDate?: string;
}

export async function performDailyClosing(input: SubmitClosingInput, user: JwtPayload) {
  // Query all bills for this branch
  // In production, filtered between startDate & endDate or current operating day
  const branchBills = await db
    .select({
      id: bills.id,
      total: bills.total,
      taxAmount: bills.taxAmount,
      paymentMode: bills.paymentMode,
      status: bills.status,
    })
    .from(bills)
    .where(eq(bills.branchId, input.branchId));

  const cashFloat: CashFloatInput = {
    openingCash: input.openingCash,
    cashWithdrawals: input.cashWithdrawals,
  };

  const recon = reconcileDailyClosing(
    branchBills.map((b) => ({
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
      openingCash: recon.openingCash,
      cashSales: recon.cashSales,
      cardSales: recon.cardSales,
      upiSales: recon.upiSales,
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

  return closingRecord;
}

export async function listDailyClosings(branchId?: string) {
  if (branchId) {
    return db.select().from(dailyClosings).where(eq(dailyClosings.branchId, branchId));
  }
  return db.select().from(dailyClosings);
}
