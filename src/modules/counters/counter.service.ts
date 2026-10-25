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
} from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
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
      productName:  r.productName,
      packQuantity: r.packQuantity,
      closingSplit: bottlesToCasesAndLoose(r.line.closingBottles, r.packQuantity),
    })),
  };
}

/** Σ approved supplier-invoice quantities per product for a branch, approvedAt in [start, end). */
async function inwardByProduct(tx: Tx, branchId: string, start: Date, end?: Date): Promise<Map<string, number>> {
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
  tx: Tx, branchId: string, start: Date, end: Date | undefined, excludeCounterSheet: boolean,
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
      if (dup) throw new ConflictError('A counter sheet already exists for this date');

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
      const movedSinceStart = await movementByProduct(tx, branchId, start, undefined, false);

      const [sheet] = await tx.insert(dailyCounterSheets).values({
        branchId,
        sheetDate,
        status:      'DRAFT',
        createdById: user.sub,
      }).returning();

      if (stocked.length > 0) {
        await tx.insert(dailyCounterSheetLines).values(stocked.map((p) => {
          const inward = inwardToday.get(p.productId) ?? 0;
          const opening = prevClosing.get(p.productId)
            ?? Math.max(0, p.quantity - (movedSinceStart.get(p.productId) ?? 0));
          return {
            sheetId:        sheet.id,
            productId:      p.productId,
            openingBottles: opening,
            inwardBottles:  inward,
            closingBottles: opening + inward,
            soldBottles:    0,
            sellingRate:    p.mrp,
            lineRevenue:    '0.00',
          };
        }));
      }
      return sheet.id;
    });
    return getSheet(id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A counter sheet already exists for this date');
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
        result = computeLine(values, { allowAdjustment: isManager && input_.approveAdjustment === true });
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
        adjustmentApprovedById: surplus ? user.sub : null,
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
        if (before === undefined) {
          await tx.insert(stock).values({ branchId: sheet.branchId, productId: line.productId, quantity: after })
            .onConflictDoUpdate({ target: [stock.branchId, stock.productId], set: { quantity: sql`${stock.quantity} + ${change}` } });
        } else if (change !== 0) {
          await tx.update(stock).set({ quantity: sql`${stock.quantity} + ${change}` })
            .where(and(eq(stock.branchId, sheet.branchId), eq(stock.productId, line.productId)));
        }
        if (change !== 0) {
          await tx.insert(stockAudit).values({
            branchId:    sheet.branchId,
            productId:   line.productId,
            userId:      user.sub,
            changeQty:   change,
            reason:      'COUNTER_SHEET',
            referenceId: sheet.id,
          });
        }
      }
    }
    return getSheet(sheetId, tx);
  });
}
