import { db } from '../../db/client.js';
import { bills, dailyClosings } from '../../db/schema.js';
import { eq, and, gte, lt, inArray, desc, sql } from 'drizzle-orm';
import { reconcileDailyClosing, type CashFloatInput } from './closing.engine.js';
import { businessDateOf, businessDayBounds } from '../../lib/business-day.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { BusinessRuleError, ConflictError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import { Decimal } from 'decimal.js';

export interface SubmitClosingInput {
  branchId: string;
  openingCash: string;
  actualCashCounted: string;
  cashWithdrawals?: string;
  cashSales?: string;
  cardSales?: string;
  upiSales?: string;
  creditSales?: string;
  notes?: string;
  businessDate?: string;   // YYYY-MM-DD; defaults to today
}

export async function performDailyClosing(input: SubmitClosingInput, user: JwtPayload) {
  // Only this branch's bills rung in on the business day being closed
  const businessDate = input.businessDate ?? businessDateOf();
  // A day that has not happened yet cannot be closed: it would lock that date (one closing per day) before
  // any sale exists and block the real closing later. ISO dates compare correctly as strings.
  if (businessDate > businessDateOf()) {
    throw new BusinessRuleError(`Cannot close ${businessDate}: that business day has not started yet.`);
  }
  const { start, end } = businessDayBounds(businessDate);

  // ── Guard: one closing per branch per calendar day ─────────────────────────
  // We store the business-day start timestamp in closing_date, so comparing
  // the date portion is equivalent to comparing businessDate strings.
  const existing = await db
    .select({ id: dailyClosings.id })
    .from(dailyClosings)
    .where(
      and(
        eq(dailyClosings.branchId, input.branchId),
        gte(dailyClosings.closingDate, start),
        lt(dailyClosings.closingDate, end),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new ConflictError(
      `Day closing for ${businessDate} has already been submitted for this branch.`,
    );
  }
  // ────────────────────────────────────────────────────────────────────────────

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

  const salesOverride = (input.cashSales !== undefined || input.cardSales !== undefined || input.upiSales !== undefined || input.creditSales !== undefined)
    ? {
        cashSales: input.cashSales,
        cardSales: input.cardSales,
        upiSales: input.upiSales,
        creditSales: input.creditSales,
      }
    : undefined;

  const billRows = dayBills.map((b) => ({
    id: b.id,
    total: b.total,
    taxAmount: b.taxAmount,
    paymentMode: b.paymentMode ?? 'CASH',
    status: b.status,
  }));

  // Managers may correct card/UPI/cash figures to match a bank or EDC settlement, but never silently:
  // any figure that differs from what the system computed needs a written reason, and the variance is kept.
  const system = reconcileDailyClosing(billRows, cashFloat, input.actualCashCounted);
  const variances: string[] = [];
  if (salesOverride) {
    for (const key of ['cashSales', 'cardSales', 'upiSales', 'creditSales'] as const) {
      const submitted = salesOverride[key];
      if (submitted === undefined) continue;
      if (!new Decimal(submitted).equals(new Decimal(system[key]))) {
        variances.push(`${key}: system ${system[key]} -> submitted ${new Decimal(submitted).toFixed(2)}`);
      }
    }
  }
  if (variances.length > 0 && (input.notes ?? '').trim().length < 10) {
    throw new BusinessRuleError(
      `Closing figures differ from the system (${variances.join('; ')}). Add a note (10+ characters) explaining why.`,
    );
  }

  const recon = reconcileDailyClosing(billRows, cashFloat, input.actualCashCounted, salesOverride);
  const storedNotes = variances.length > 0
    ? `${(input.notes ?? '').trim()}\n[Figures overridden by ${user.email}] ${variances.join('; ')}`
    : input.notes;

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
      notes: storedNotes,
      status: 'CLOSED',
    })
    .returning();

  if (variances.length > 0) {
    await logAudit(user.sub, 'closing.override', { type: 'daily_closing', id: closingRecord.id }, { businessDate, variances });
  }

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

/** Pre-closing live preview for a business date: aggregates today's bills and checks if already closed. */
export async function getDailyClosingPreview(branchId: string, requestedDate?: string) {
  const businessDate = requestedDate ?? businessDateOf();
  const { start, end } = businessDayBounds(businessDate);

  const [existing] = await db
    .select()
    .from(dailyClosings)
    .where(
      and(
        eq(dailyClosings.branchId, branchId),
        gte(dailyClosings.closingDate, start),
        lt(dailyClosings.closingDate, end),
      ),
    )
    .limit(1);

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
      eq(bills.branchId, branchId),
      gte(bills.createdAt, start),
      lt(bills.createdAt, end),
    ));

  const [lastClosing] = await db
    .select({ actualCashCounted: dailyClosings.actualCashCounted })
    .from(dailyClosings)
    .where(eq(dailyClosings.branchId, branchId))
    .orderBy(desc(dailyClosings.closingDate))
    .limit(1);

  const suggestedOpeningCash = lastClosing?.actualCashCounted ?? '2000.00';

  const rawRecon = reconcileDailyClosing(
    dayBills.map((b) => ({
      id: b.id,
      total: b.total,
      taxAmount: b.taxAmount,
      paymentMode: b.paymentMode ?? 'CASH',
      status: b.status,
    })),
    { openingCash: suggestedOpeningCash, cashWithdrawals: '0' },
    suggestedOpeningCash,
  );

  return {
    branchId,
    businessDate,
    isAlreadyClosed: !!existing,
    existingClosing: existing ?? null,
    suggestedOpeningCash,
    sales: {
      cashSales: rawRecon.cashSales,
      cardSales: rawRecon.cardSales,
      upiSales: rawRecon.upiSales,
      creditSales: rawRecon.creditSales,
      grossSales: rawRecon.grossSales,
      totalTax: rawRecon.totalTax,
      paidBillsCount: rawRecon.paidBillsCount,
      voidedBillsCount: rawRecon.voidedBillsCount,
      totalBillsCount: rawRecon.totalBillsCount,
    },
  };
}
