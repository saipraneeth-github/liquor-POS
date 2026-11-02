import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  dailyCounterSheets,
  dailyCounterSheetLines,
  products,
  stock,
  stockAudit,
  supplierInvoices,
  supplierInvoiceItems,
  bills,
  billItems,
} from '../../db/schema.js';
import { onDomainEvent, type Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { businessDateOf, businessDayBounds, isIsoDate } from '../../lib/business-day.js';
import { roleRank, ROLE_RANK } from '../../middleware/auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import {
  computeLine,
  computeSheetTotal,
  violatesInvariant,
  bottlesToCasesAndLoose,
  CounterInvariantError,
} from './counter.engine.js';

// ─── SCHEMAS ─────────────────────────────────────────────────────────────────

const BOTTLES = z.number().int().min(0).max(1_000_000);

export const CreateSheetSchema = z.object({
  sheetDate: z.string().refine(isIsoDate, 'sheetDate must be YYYY-MM-DD'),
});

export const ListSheetsQuerySchema = z.object({
  date: z.string().refine(isIsoDate, 'date must be YYYY-MM-DD').optional(),
});

export const UpdateLinesSchema = z.object({
  lines: z.array(z.object({
    productId:         z.string().uuid(),
    closingBottles:    BOTTLES,
    inwardBottles:     BOTTLES.optional(),
    approveAdjustment: z.boolean().optional(),
  })).min(1).max(5000),
}).refine((d) => new Set(d.lines.map((l) => l.productId)).size === d.lines.length, {
  message: 'Duplicate productId in lines',
  path: ['lines'],
});

export type UpdateLinesInput = z.infer<typeof UpdateLinesSchema>;
export type SheetRow = typeof dailyCounterSheets.$inferSelect;

// ─── QUERIES ─────────────────────────────────────────────────────────────────

export async function getSheetRow(id: string): Promise<SheetRow | undefined> {
  const [row] = await db.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, id)).limit(1);
  return row;
}

export async function listSheets(branchId: string, date?: string): Promise<SheetRow[]> {
  const conditions = [eq(dailyCounterSheets.branchId, branchId)];
  if (date) conditions.push(eq(dailyCounterSheets.sheetDate, date));
  return db.select().from(dailyCounterSheets).where(and(...conditions)).orderBy(desc(dailyCounterSheets.sheetDate));
}

export async function getSheet(id: string, tx: Tx | typeof db = db) {
  const [sheet] = await tx.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, id)).limit(1);
  if (!sheet) throw new NotFoundError('Counter sheet not found');
  const { start, end } = businessDayBounds(sheet.sheetDate);
  const salesMap = await salesByProduct(tx, sheet.branchId, start, end);

  // If this is a DRAFT sheet and some products have sales that haven't been reflected yet
  // (e.g. line.soldBottles === 0, line.closingBottles === line.openingBottles + line.inwardBottles, but posSold > 0),
  // auto-sync those lines so the counter sheet immediately displays live sales.
  if (sheet.status === 'DRAFT') {
    const lines = await tx
      .select()
      .from(dailyCounterSheetLines)
      .where(eq(dailyCounterSheetLines.sheetId, id));

    let needsSheetTotalUpdate = false;
    for (const l of lines) {
      const posSold = salesMap.get(l.productId)?.bottles ?? 0;
      const available = l.openingBottles + l.inwardBottles;
      if (posSold > 0 && l.soldBottles === 0 && l.closingBottles === available) {
        const expectedClosing = Math.max(0, available - posSold);
        const res = computeLine(
          { opening: l.openingBottles, inward: l.inwardBottles, closing: expectedClosing, rate: l.sellingRate },
          { allowAdjustment: true },
        );
        await tx
          .update(dailyCounterSheetLines)
          .set({
            closingBottles: expectedClosing,
            soldBottles:    res.sold,
            lineRevenue:    res.revenue,
          })
          .where(eq(dailyCounterSheetLines.id, l.id));
        needsSheetTotalUpdate = true;
      }
    }

    if (needsSheetTotalUpdate) {
      const updatedLines = await tx
        .select({ revenue: dailyCounterSheetLines.lineRevenue })
        .from(dailyCounterSheetLines)
        .where(eq(dailyCounterSheetLines.sheetId, id));
      const totalRevenue = computeSheetTotal(updatedLines);
      await tx
        .update(dailyCounterSheets)
        .set({ totalRevenue })
        .where(eq(dailyCounterSheets.id, id));
      sheet.totalRevenue = totalRevenue;
    }
  }

  const rows = await tx
    .select({ line: dailyCounterSheetLines, productName: products.name, packQuantity: products.packQuantity })
    .from(dailyCounterSheetLines)
    .innerJoin(products, eq(products.id, dailyCounterSheetLines.productId))
    .where(eq(dailyCounterSheetLines.sheetId, id))
    .orderBy(asc(products.name));

  return {
    ...sheet,
    lines: rows.map((r) => ({
      ...r.line,
      productName:    r.productName,
      packQuantity:   r.packQuantity,
      posSoldBottles: salesMap.get(r.line.productId)?.bottles ?? 0,
      closingSplit:   bottlesToCasesAndLoose(r.line.closingBottles, r.packQuantity),
    })),
  };
}

/** Σ bottles sold from paid bills per product for a branch, createdAt in [start, end). */
export async function salesByProduct(
  tx: Tx | typeof db,
  branchId: string,
  start: Date,
  end?: Date,
): Promise<Map<string, { bottles: number; revenue: string }>> {
  const conditions = [
    eq(bills.branchId, branchId),
    eq(bills.status, 'PAID'),
    gte(bills.createdAt, start),
  ];
  if (end) conditions.push(lt(bills.createdAt, end));

  const rows = await tx
    .select({
      productId: billItems.productId,
      qty:       sql<string>`coalesce(sum(${billItems.quantity}), 0)`,
      revenue:   sql<string>`coalesce(sum(${billItems.lineTotal}), 0)`,
    })
    .from(billItems)
    .innerJoin(bills, eq(bills.id, billItems.billId))
    .where(and(...conditions))
    .groupBy(billItems.productId);

  return new Map(
    rows.map((r) => [
      r.productId,
      { bottles: Math.max(0, Math.round(Number(r.qty))), revenue: r.revenue ?? '0.00' },
    ]),
  );
}

/** Σ approved supplier-invoice quantities per product for a branch, approvedAt in [start, end). */
async function inwardByProduct(tx: Tx | typeof db, branchId: string, start: Date, end?: Date): Promise<Map<string, number>> {
  const conditions = [
    eq(supplierInvoices.branchId, branchId),
    eq(supplierInvoices.status, 'APPROVED'),
    isNotNull(supplierInvoiceItems.productId),
    gte(supplierInvoices.approvedAt, start),
  ];
  if (end) conditions.push(lt(supplierInvoices.approvedAt, end));
  const rows = await tx
    .select({
      productId: supplierInvoiceItems.productId,
      qty:       sql<string>`coalesce(sum(${supplierInvoiceItems.quantity}), 0)`,
    })
    .from(supplierInvoiceItems)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceItems.invoiceId))
    .where(and(...conditions))
    .groupBy(supplierInvoiceItems.productId);
  return new Map(rows.map((r) => [r.productId!, Number(r.qty)]));
}

/**
 * Net recorded stock movement (Σ stock_audit.change_qty) per product for a branch, createdAt in
 * [start, end). `excludeCounterSheet` leaves out COUNTER_SHEET corrections, which belong to the
 * day of the sheet that made them rather than to the moment it was posted.
 */
async function movementByProduct(
  tx: Tx | typeof db, branchId: string, start: Date, end: Date | undefined, excludeCounterSheet: boolean,
): Promise<Map<string, number>> {
  const conditions = [eq(stockAudit.branchId, branchId), gte(stockAudit.createdAt, start)];
  if (end) conditions.push(lt(stockAudit.createdAt, end));
  if (excludeCounterSheet) conditions.push(ne(stockAudit.reason, 'COUNTER_SHEET'));
  const rows = await tx
    .select({
      productId: stockAudit.productId,
      qty:       sql<string>`coalesce(sum(${stockAudit.changeQty}), 0)`,
    })
    .from(stockAudit)
    .where(and(...conditions))
    .groupBy(stockAudit.productId);
  return new Map(rows.map((r) => [r.productId, Number(r.qty)]));
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

/**
 * Creates a DRAFT sheet with one line per active stocked product.
 *   opening = stock at the start of sheetDate:
 *             closing of the latest POSTED sheet before sheetDate plus every recorded movement
 *             (stock_audit, COUNTER_SHEET corrections excluded) between that sheet's day and sheetDate;
 *             otherwise the current stock rewound by every movement recorded since the start of
 *             sheetDate (so the value does not depend on when during the day the sheet is created,
 *             and the day's inward — already in stock — is not counted twice)
 *   inward  = approved supplier-invoice quantities approved on sheetDate
 *   closing = opening + inward (to be counted), rate = MRP
 */
export async function createSheet(user: JwtPayload, branchId: string, sheetDate: string) {
  if (sheetDate > businessDateOf()) throw new BusinessRuleError('Cannot create a counter sheet for a future date');
  const { start, end } = businessDayBounds(sheetDate);
  try {
    const id = await db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
        .where(and(eq(dailyCounterSheets.branchId, branchId), eq(dailyCounterSheets.sheetDate, sheetDate))).limit(1);
      if (dup) throw new ConflictError('A counter sheet already exists for this date', { sheetId: dup.id });

      const stocked = await tx
        .select({ productId: products.id, mrp: products.mrp, quantity: stock.quantity })
        .from(stock)
        .innerJoin(products, eq(products.id, stock.productId))
        .where(and(eq(stock.branchId, branchId), eq(products.isActive, true)));

      const previous = await tx
        .selectDistinctOn([dailyCounterSheetLines.productId], {
          productId: dailyCounterSheetLines.productId,
          closing:   dailyCounterSheetLines.closingBottles,
          sheetDate: dailyCounterSheets.sheetDate,
        })
        .from(dailyCounterSheetLines)
        .innerJoin(dailyCounterSheets, eq(dailyCounterSheets.id, dailyCounterSheetLines.sheetId))
        .where(and(
          eq(dailyCounterSheets.branchId, branchId),
          eq(dailyCounterSheets.status, 'POSTED'),
          lt(dailyCounterSheets.sheetDate, sheetDate),
        ))
        .orderBy(dailyCounterSheetLines.productId, desc(dailyCounterSheets.sheetDate));
      // Opening carries the last posted closing forward plus the movements recorded on the days in
      // between (days without a sheet: inward, POS sales, voids, breakage), so none are lost.
      const gapMovement = new Map<string, Map<string, number>>();   // previous sheetDate → net movement per product
      for (const prevDate of new Set(previous.map((p) => p.sheetDate))) {
        gapMovement.set(prevDate, await movementByProduct(tx, branchId, businessDayBounds(prevDate).end, start, true));
      }
      const prevClosing = new Map(previous.map((p) => [
        p.productId,
        Math.max(0, p.closing + (gapMovement.get(p.sheetDate)?.get(p.productId) ?? 0)),
      ]));

      const inwardToday = await inwardByProduct(tx, branchId, start, end);
      const salesToday = await salesByProduct(tx, branchId, start, end);
      const movedSinceStart = await movementByProduct(tx, branchId, start, undefined, false);

      const [sheet] = await tx.insert(dailyCounterSheets).values({
        branchId,
        sheetDate,
        status:      'DRAFT',
        createdById: user.sub,
      }).returning();

      if (stocked.length > 0) {
        const lineValues = stocked.map((p) => {
          const inward = inwardToday.get(p.productId) ?? 0;
          const posSold = salesToday.get(p.productId)?.bottles ?? 0;
          const opening = prevClosing.get(p.productId)
            ?? Math.max(0, p.quantity - (movedSinceStart.get(p.productId) ?? 0));
          const closing = Math.max(0, opening + inward - posSold);
          const lineRes = computeLine(
            { opening, inward, closing, rate: p.mrp },
            { allowAdjustment: true },
          );
          return {
            sheetId:        sheet.id,
            productId:      p.productId,
            openingBottles: opening,
            inwardBottles:  inward,
            closingBottles: closing,
            soldBottles:    lineRes.sold,
            sellingRate:    p.mrp,
            lineRevenue:    lineRes.revenue,
          };
        });

        await tx.insert(dailyCounterSheetLines).values(lineValues);

        const totalRevenue = computeSheetTotal(lineValues.map((l) => ({ revenue: l.lineRevenue })));
        await tx.update(dailyCounterSheets).set({ totalRevenue }).where(eq(dailyCounterSheets.id, sheet.id));
      }
      return sheet.id;
    });
    return getSheet(id);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [existing] = await db.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
        .where(and(eq(dailyCounterSheets.branchId, branchId), eq(dailyCounterSheets.sheetDate, sheetDate))).limit(1);
      throw new ConflictError('A counter sheet already exists for this date', { sheetId: existing?.id });
    }
    throw err;
  }
}

// ─── UPDATE LINES ────────────────────────────────────────────────────────────

export async function updateSheetLines(user: JwtPayload, sheetId: string, input: UpdateLinesInput) {
  const isManager = roleRank(user.role) >= ROLE_RANK.manager;

  return db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, sheetId)).for('update');
    if (!sheet) throw new NotFoundError('Counter sheet not found');
    if (sheet.status !== 'DRAFT') throw new ConflictError('Counter sheet is already posted');

    const existing = await tx.select().from(dailyCounterSheetLines).where(eq(dailyCounterSheetLines.sheetId, sheetId));
    const byProduct = new Map(existing.map((l) => [l.productId, l]));

    for (const input_ of input.lines) {
      const line = byProduct.get(input_.productId);
      if (!line) throw new BusinessRuleError(`Product ${input_.productId} is not on this sheet`);

      // Inward comes from approved supplier invoices; lowering it would understate sold bottles and revenue
      if (input_.inwardBottles !== undefined && input_.inwardBottles !== line.inwardBottles && !isManager) {
        throw new BusinessRuleError(`Only a manager can change the inward count for product ${input_.productId}`);
      }

      const values = {
        opening: line.openingBottles,
        inward:  input_.inwardBottles ?? line.inwardBottles,
        closing: input_.closingBottles,
        rate:    line.sellingRate,
      };
      const surplus = violatesInvariant(values);
      if (surplus && input_.approveAdjustment && !isManager) {
        throw new BusinessRuleError(`Only a manager can approve the adjustment for product ${input_.productId}`);
      }
      let result;
      try {
      const alreadyApproved = line.adjustmentApprovedById !== null && values.closing <= line.closingBottles && values.inward === line.inwardBottles;
      const allowAdjustment = (isManager && input_.approveAdjustment === true) || alreadyApproved;
      result = computeLine(values, { allowAdjustment });
      } catch (err) {
        if (err instanceof CounterInvariantError) {
          throw new BusinessRuleError(`Product ${input_.productId}: ${err.message}`);
        }
        throw err;
      }

      await tx.update(dailyCounterSheetLines).set({
        inwardBottles:          values.inward,
        closingBottles:         values.closing,
        soldBottles:            result.sold,
        lineRevenue:            result.revenue,
        adjustmentApprovedById: surplus ? (isManager && input_.approveAdjustment ? user.sub : (alreadyApproved ? line.adjustmentApprovedById : user.sub)) : null,
      }).where(eq(dailyCounterSheetLines.id, line.id));
      byProduct.set(line.productId, { ...line, lineRevenue: result.revenue });
    }

    const totalRevenue = computeSheetTotal([...byProduct.values()].map((l) => ({ revenue: l.lineRevenue })));
    await tx.update(dailyCounterSheets).set({ totalRevenue }).where(eq(dailyCounterSheets.id, sheetId));
    return getSheet(sheetId, tx);
  });
}

// ─── POST ────────────────────────────────────────────────────────────────────

/**
 * DRAFT → POSTED. Corrects each product's stock so that, as of the end of the sheet day, it equals
 * the counted closing:
 *   stockAtDayEnd = current stock − Σ movements recorded after the sheet day (COUNTER_SHEET excluded)
 *   change        = closing − stockAtDayEnd       (applied as a delta: quantity = quantity + change)
 * so POS bills already deducted are not double counted, and sales / inward / voids recorded after
 * the sheet day (e.g. a sheet posted the next morning) are kept rather than overwritten.
 * Writes a COUNTER_SHEET audit row per non-zero change.
 */
export async function postSheet(user: JwtPayload, sheetId: string) {
  return db.transaction(async (tx) => {
    // Serialise posts per branch: lock every sheet of the branch so two sheets of different dates
    // posted concurrently cannot both pass the "no later posted sheet" check below.
    const [target] = await tx.select({ branchId: dailyCounterSheets.branchId }).from(dailyCounterSheets)
      .where(eq(dailyCounterSheets.id, sheetId)).limit(1);
    if (!target) throw new NotFoundError('Counter sheet not found');
    await tx.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
      .where(eq(dailyCounterSheets.branchId, target.branchId))
      .orderBy(asc(dailyCounterSheets.id))
      .for('update');

    const [sheet] = await tx.update(dailyCounterSheets).set({
      status:     'POSTED',
      postedById: user.sub,
      postedAt:   new Date(),
    }).where(and(eq(dailyCounterSheets.id, sheetId), eq(dailyCounterSheets.status, 'DRAFT'))).returning();

    if (!sheet) {
      const [exists] = await tx.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
        .where(eq(dailyCounterSheets.id, sheetId)).limit(1);
      if (!exists) throw new NotFoundError('Counter sheet not found');
      throw new ConflictError('Counter sheet is already posted');
    }

    const [later] = await tx.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
      .where(and(
        eq(dailyCounterSheets.branchId, sheet.branchId),
        eq(dailyCounterSheets.status, 'POSTED'),
        gt(dailyCounterSheets.sheetDate, sheet.sheetDate),
      )).limit(1);
    if (later) throw new BusinessRuleError('A later counter sheet is already posted; this sheet would overwrite newer stock');

    const lines = await tx.select().from(dailyCounterSheetLines).where(eq(dailyCounterSheetLines.sheetId, sheetId));
    if (lines.length > 0) {
      const productIds = lines.map((l) => l.productId);
      const stockRows = await tx.select().from(stock)
        .where(and(eq(stock.branchId, sheet.branchId), inArray(stock.productId, productIds)))
        .for('update');
      const current = new Map(stockRows.map((s) => [s.productId, s.quantity]));
      const movedAfter = await movementByProduct(tx, sheet.branchId, businessDayBounds(sheet.sheetDate).end, undefined, true);

      const stockUpsertsMap = new Map<string, { branchId: string; productId: string; quantity: number }>();
      const stockAuditInserts: { branchId: string; productId: string; userId: string; changeQty: number; reason: 'COUNTER_SHEET'; referenceId: string }[] = [];

      for (const line of lines) {
        const before = current.get(line.productId);
        const atDayEnd = (before ?? 0) - (movedAfter.get(line.productId) ?? 0);
        const change = line.closingBottles - atDayEnd;
        const after = (before ?? 0) + change;

        if (after < 0) {
          throw new BusinessRuleError(
            `Product ${line.productId}: closing count ${line.closingBottles} is below the stock moved out since the sheet day`,
          );
        }

        if (change !== 0) {
          const existing = stockUpsertsMap.get(line.productId);
          if (existing) {
            existing.quantity += change;
          } else {
            stockUpsertsMap.set(line.productId, { branchId: sheet.branchId, productId: line.productId, quantity: change });
          }

          stockAuditInserts.push({
            branchId:    sheet.branchId,
            productId:   line.productId,
            userId:      user.sub,
            changeQty:   change,
            reason:      'COUNTER_SHEET',
            referenceId: sheet.id,
          });
        }
      }

      const stockUpserts = Array.from(stockUpsertsMap.values());
      if (stockUpserts.length > 0) {
        // ⚡ Bolt Optimization: Batch upsert stock records to prevent N+1 queries and DB lock contention
        await tx.insert(stock).values(stockUpserts)
          .onConflictDoUpdate({ target: [stock.branchId, stock.productId], set: { quantity: sql`${stock.quantity} + EXCLUDED.quantity` } });
      }

      if (stockAuditInserts.length > 0) {
        // ⚡ Bolt Optimization: Batch insert stock audit records
        await tx.insert(stockAudit).values(stockAuditInserts);
      }
    }
    return getSheet(sheetId, tx);
  });
}

/**
 * Synchronizes all lines of a DRAFT counter sheet with approved supplier invoices (inward)
 * and paid POS bills (sales) for that sheet date:
 *   closing = Math.max(0, opening + inward - posSold)
 *   sold    = opening + inward - closing (= posSold)
 *   revenue = sold * rate
 */
export async function syncSheetWithSales(sheetId: string, txHandle?: Tx) {
  const runner = async (tx: Tx) => {
    const [sheet] = await tx.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, sheetId)).limit(1);
    if (!sheet) throw new NotFoundError('Counter sheet not found');
    if (sheet.status !== 'DRAFT') throw new BusinessRuleError('Cannot sync a posted counter sheet');

    const { start, end } = businessDayBounds(sheet.sheetDate);
    const inwardMap = await inwardByProduct(tx, sheet.branchId, start, end);
    const salesMap = await salesByProduct(tx, sheet.branchId, start, end);

    const lines = await tx
      .select()
      .from(dailyCounterSheetLines)
      .where(eq(dailyCounterSheetLines.sheetId, sheetId));

    for (const l of lines) {
      const inward = inwardMap.get(l.productId) ?? l.inwardBottles;
      const posSold = salesMap.get(l.productId)?.bottles ?? 0;
      const available = l.openingBottles + inward;
      const closing = Math.max(0, available - posSold);
      const res = computeLine(
        { opening: l.openingBottles, inward, closing, rate: l.sellingRate },
        { allowAdjustment: true },
      );

      await tx
        .update(dailyCounterSheetLines)
        .set({
          inwardBottles:  inward,
          closingBottles: closing,
          soldBottles:    res.sold,
          lineRevenue:    res.revenue,
        })
        .where(eq(dailyCounterSheetLines.id, l.id));
    }

    const updatedLines = await tx
      .select({ revenue: dailyCounterSheetLines.lineRevenue })
      .from(dailyCounterSheetLines)
      .where(eq(dailyCounterSheetLines.sheetId, sheetId));

    const totalRevenue = computeSheetTotal(updatedLines);
    await tx.update(dailyCounterSheets).set({ totalRevenue }).where(eq(dailyCounterSheets.id, sheetId));

    return getSheet(sheetId, tx);
  };

  return txHandle ? runner(txHandle) : db.transaction(runner);
}

/**
 * Automatically updates any active DRAFT counter sheet for this branch & business date
 * when a bill is paid or voided.
 */
export async function onBillPaidOrVoided(branchId: string, billCreatedAt: Date, tx: Tx) {
  const sheetDate = businessDateOf(billCreatedAt);
  const [draftSheet] = await tx
    .select({ id: dailyCounterSheets.id })
    .from(dailyCounterSheets)
    .where(
      and(
        eq(dailyCounterSheets.branchId, branchId),
        eq(dailyCounterSheets.sheetDate, sheetDate),
        eq(dailyCounterSheets.status, 'DRAFT'),
      ),
    )
    .limit(1);

  if (draftSheet) {
    await syncSheetWithSales(draftSheet.id, tx);
  }
}

let counterUnsubscribers: (() => void)[] | null = null;

export function registerCounterSheetHandlers(): void {
  if (counterUnsubscribers) return;
  counterUnsubscribers = [
    onDomainEvent('bill.paid', async ({ bill }, tx) => {
      await onBillPaidOrVoided(bill.branchId, bill.createdAt ?? new Date(), tx);
    }),
    onDomainEvent('bill.voided', async ({ bill }, tx) => {
      await onBillPaidOrVoided(bill.branchId, bill.createdAt ?? new Date(), tx);
    }),
  ];
}

export function unregisterCounterSheetHandlers(): void {
  for (const off of counterUnsubscribers ?? []) off();
  counterUnsubscribers = null;
}

// ─── EXPORT / CSV ────────────────────────────────────────────────────────────

export function sheetToCsv(sheet: {
  sheetDate: string;
  status: string;
  totalRevenue: string;
  lines: Array<{
    productName: string;
    packQuantity?: number | null;
    openingBottles: number;
    inwardBottles: number;
    posSoldBottles?: number;
    soldBottles: number;
    closingBottles: number;
    closingSplit?: { cases: number; loose: number } | null;
    sellingRate: string;
    lineRevenue: string;
  }>;
}, branchName?: string): string {
  const sanitize = (val: string | number | undefined | null) => {
    if (val === undefined || val === null) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headerLines = [
    `Daily Counter Sheet${branchName ? ` - ${branchName}` : ''}`,
    `Sheet Date: ${sheet.sheetDate}`,
    `Status: ${sheet.status}`,
    `Total Revenue: ₹${sheet.totalRevenue}`,
    '',
    [
      'Product',
      'Pack Qty',
      'Opening (Bottles)',
      'Inward (Bottles)',
      'POS Sold (Bottles)',
      'Counter Sold (Bottles)',
      'Closing (Bottles)',
      'Closing Cases',
      'Closing Loose',
      'Rate (MRP)',
      'Line Revenue',
    ].map(sanitize).join(','),
  ];

  const dataRows = sheet.lines.map((l) => [
    sanitize(l.productName),
    sanitize(l.packQuantity ?? 1),
    l.openingBottles,
    l.inwardBottles,
    l.posSoldBottles ?? 0,
    l.soldBottles,
    l.closingBottles,
    l.closingSplit?.cases ?? '',
    l.closingSplit?.loose ?? '',
    sanitize(l.sellingRate),
    sanitize(l.lineRevenue),
  ].join(','));

  const footer = [
    '',
    ['Total', '', '', '', '', '', '', '', '', '', sanitize(sheet.totalRevenue)].join(','),
  ];

  return [...headerLines, ...dataRows, ...footer].join('\r\n');
}

export async function getSheetCsv(id: string): Promise<{ csv: string; filename: string }> {
  const sheet = await getSheet(id);
  const csv = sheetToCsv(sheet);
  const filename = `counter-sheet-${sheet.sheetDate}.csv`;
  return { csv, filename };
}

export async function getBranchSheetCsv(branchId: string, date?: string): Promise<{ csv: string; filename: string }> {
  const sheets = await listSheets(branchId, date);
  if (sheets.length === 0) {
    throw new NotFoundError(date ? `No counter sheet found for date ${date}` : 'No counter sheets found for this branch');
  }
  const sheet = await getSheet(sheets[0].id);
  const csv = sheetToCsv(sheet);
  const filename = `counter-sheet-${sheet.sheetDate}.csv`;
  return { csv, filename };
}
