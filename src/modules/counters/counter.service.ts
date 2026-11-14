import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import {
  categories,
  dailyCounterSheets,
  dailyCounterSheetLines,
  journalVouchers,
  productPrices,
  products,
  saleTypes,
  stock,
  stockAudit,
  stockByType,
  supplierInvoices,
  supplierInvoiceItems,
  bills,
  billItems,
} from '../../db/schema.js';
import { postCounterSheetSales, reverseCounterSheetSales } from '../accounting/posting.service.js';
import { resolveTaxRate } from '../billing/billing.engine.js';
import { counterQuantity, explicitTotal, rowTypeId } from '../saletypes/saletype.engine.js';
import { explicitSums, resolveSaleType } from '../saletypes/saletype.service.js';
import { onDomainEvent, type Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
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
  /** Which sale type's counter this sheet counts (Walk-in, Janata, ...); omitted = the default type. */
  saleTypeId: z.string().uuid().nullable().optional(),
});

export const ListSheetsQuerySchema = z.object({
  date: z.string().refine(isIsoDate, 'date must be YYYY-MM-DD').optional(),
  saleTypeId: z.string().uuid().optional(),
  format: z.enum(['csv', 'xlsx', 'excel']).optional(),
});

export const UpdateLinesSchema = z.object({
  lines: z.array(z.object({
    productId:         z.string().uuid(),
    closingBottles:    BOTTLES,
    inwardBottles:     BOTTLES.optional(),
    openingBottles:    BOTTLES.optional(),      // needs the counter.opening permission

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

/** `sale_type_id = X`, with NULL meaning the default sale type. */
function typeIs(col: AnyPgColumn, typeId: string | null): SQL {
  return typeId === null ? isNull(col) : eq(col, typeId);
}

/** Sheets of a branch; `saleTypeId` = undefined → every sale type, null → the default type only. */
export async function listSheets(branchId: string, date?: string, saleTypeId?: string | null): Promise<SheetRow[]> {
  const conditions = [eq(dailyCounterSheets.branchId, branchId)];
  if (date) conditions.push(eq(dailyCounterSheets.sheetDate, date));
  if (saleTypeId !== undefined) conditions.push(typeIs(dailyCounterSheets.saleTypeId, saleTypeId));
  return db.select().from(dailyCounterSheets).where(and(...conditions)).orderBy(desc(dailyCounterSheets.sheetDate));
}

export async function getSheet(id: string, tx: Tx | typeof db = db) {
  const [sheet] = await tx.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, id)).limit(1);
  if (!sheet) throw new NotFoundError('Counter sheet not found');
  const { start, end } = businessDayBounds(sheet.sheetDate);
  const salesMap = await salesByProduct(tx, sheet.branchId, start, end, sheet.saleTypeId);
  const transferMap = await transferByProduct(tx, sheet.branchId, start, end, sheet.saleTypeId);

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
      const transfer = transferMap.get(l.productId) ?? l.transferBottles;
      const available = l.openingBottles + l.inwardBottles + transfer;
      if (posSold > 0 && l.soldBottles === 0 && l.closingBottles === available) {
        const expectedClosing = Math.max(0, available - posSold);
        const res = computeLine(
          { opening: l.openingBottles, inward: l.inwardBottles, closing: expectedClosing, rate: l.sellingRate, transfer },
          { allowAdjustment: true },
        );
        await tx
          .update(dailyCounterSheetLines)
          .set({
            closingBottles: expectedClosing,
            transferBottles: transfer,
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

  const [typeRow] = sheet.saleTypeId
    ? await tx.select({ name: saleTypes.name }).from(saleTypes).where(eq(saleTypes.id, sheet.saleTypeId)).limit(1)
    : [undefined];

  return {
    ...sheet,
    saleTypeName: typeRow?.name ?? null,    // null = the default sale type (Walk-in)
    lines: rows.map((r) => ({
      ...r.line,
      productName:    r.productName,
      packQuantity:   r.packQuantity,
      posSoldBottles: salesMap.get(r.line.productId)?.bottles ?? 0,
      closingSplit:   bottlesToCasesAndLoose(r.line.closingBottles, r.packQuantity),
    })),
  };
}

/**
 * Σ bottles sold from paid bills per product for a branch, createdAt in [start, end).
 * `saleTypeId` null = bills of the default sale type; a sale type id = only that type's bills.
 */
export async function salesByProduct(
  tx: Tx | typeof db,
  branchId: string,
  start: Date,
  end?: Date,
  saleTypeId: string | null = null,
  productIds?: string[],
): Promise<Map<string, { bottles: number; revenue: string }>> {
  const conditions = [
    eq(bills.branchId, branchId),
    eq(bills.status, 'PAID'),
    gte(bills.createdAt, start),
    typeIs(bills.saleTypeId, saleTypeId),
  ];
  if (end) conditions.push(lt(bills.createdAt, end));
  if (productIds && productIds.length > 0) {
    conditions.push(inArray(billItems.productId, productIds));
  }

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

/** Σ approved supplier-invoice quantities and purchase audits per product for a branch, in [start, end). */
async function inwardByProduct(tx: Tx | typeof db, branchId: string, start: Date, end?: Date, productIds?: string[]): Promise<Map<string, number>> {
  const invConditions = [
    eq(supplierInvoices.branchId, branchId),
    eq(supplierInvoices.status, 'APPROVED'),
    isNotNull(supplierInvoiceItems.productId),
    gte(supplierInvoices.approvedAt, start),
  ];
  if (end) invConditions.push(lt(supplierInvoices.approvedAt, end));
  if (productIds && productIds.length > 0) {
    invConditions.push(inArray(supplierInvoiceItems.productId, productIds));
  }
  const invRows = await tx
    .select({
      productId: supplierInvoiceItems.productId,
      qty:       sql<string>`coalesce(sum(${supplierInvoiceItems.quantity}), 0)`,
    })
    .from(supplierInvoiceItems)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceItems.invoiceId))
    .where(and(...invConditions))
    .groupBy(supplierInvoiceItems.productId);

  const auditConditions = [
    eq(stockAudit.branchId, branchId),
    eq(stockAudit.reason, 'PURCHASE'),
    gte(stockAudit.createdAt, start),
  ];
  if (end) auditConditions.push(lt(stockAudit.createdAt, end));
  if (productIds && productIds.length > 0) {
    auditConditions.push(inArray(stockAudit.productId, productIds));
  }
  const auditRows = await tx
    .select({
      productId: stockAudit.productId,
      qty:       sql<string>`coalesce(sum(${stockAudit.changeQty}), 0)`,
    })
    .from(stockAudit)
    .where(and(...auditConditions))
    .groupBy(stockAudit.productId);

  const res = new Map<string, number>();
  for (const r of invRows) {
    if (r.productId) res.set(r.productId, Math.max(0, Math.round(Number(r.qty))));
  }
  for (const r of auditRows) {
    if (r.productId) {
      const prev = res.get(r.productId) ?? 0;
      res.set(r.productId, Math.max(prev, Math.round(Number(r.qty))));
    }
  }
  return res;
}

/**
 * Net recorded stock movement (Σ stock_audit.change_qty) per product for a branch, createdAt in
 * [start, end). `excludeCounterSheet` leaves out COUNTER_SHEET corrections, which belong to the
 * day of the sheet that made them rather than to the moment it was posted.
 */
async function movementByProduct(
  tx: Tx | typeof db, branchId: string, start: Date, end: Date | undefined, excludeCounterSheet: boolean,
  saleTypeId: string | null = null,
): Promise<Map<string, number>> {
  // each counter only sees the movements recorded against it (NULL = the default counter)
  const conditions = [eq(stockAudit.branchId, branchId), gte(stockAudit.createdAt, start), typeIs(stockAudit.saleTypeId, saleTypeId)];
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

/** Net bottles moved into (+) / out of (−) a counter by TYPE_TRANSFER rows in [start, end). */
async function transferByProduct(
  tx: Tx | typeof db, branchId: string, start: Date, end: Date | undefined, saleTypeId: string | null, productIds?: string[],
): Promise<Map<string, number>> {
  const conditions = [
    eq(stockAudit.branchId, branchId), eq(stockAudit.reason, 'TYPE_TRANSFER'), gte(stockAudit.createdAt, start),
    typeIs(stockAudit.saleTypeId, saleTypeId),
  ];
  if (end) conditions.push(lt(stockAudit.createdAt, end));
  if (productIds && productIds.length > 0) {
    conditions.push(inArray(stockAudit.productId, productIds));
  }
  const rows = await tx
    .select({ productId: stockAudit.productId, qty: sql<string>`coalesce(sum(${stockAudit.changeQty}), 0)` })
    .from(stockAudit).where(and(...conditions)).groupBy(stockAudit.productId);
  return new Map(rows.map((r) => [r.productId, Number(r.qty)]));
}

/** Bottles written off (breakage / damage) in [start, end) from a counter — they left the shelf without being sold. */
async function writtenOffByProduct(
  tx: Tx | typeof db, branchId: string, start: Date, end: Date | undefined, saleTypeId: string | null,
): Promise<Map<string, number>> {
  const conditions = [
    eq(stockAudit.branchId, branchId), inArray(stockAudit.reason, ['BREAKAGE', 'DAMAGE']), gte(stockAudit.createdAt, start),
    typeIs(stockAudit.saleTypeId, saleTypeId),
  ];
  if (end) conditions.push(lt(stockAudit.createdAt, end));
  const rows = await tx
    .select({ productId: stockAudit.productId, qty: sql<string>`coalesce(sum(-${stockAudit.changeQty}), 0)` })
    .from(stockAudit).where(and(...conditions)).groupBy(stockAudit.productId);
  return new Map(rows.map((r) => [r.productId, Math.max(0, Number(r.qty))]));
}

/**
 * What one counter holds right now, with the rate it sells at.
 *   default type : every active stocked product; quantity = shop total − Σ other counters; rate = MRP
 *   other type   : products with an explicit counter row; quantity = that row; rate = the type's price (MRP if unpriced)
 */
async function counterStocks(
  tx: Tx | typeof db, branchId: string, saleTypeId: string | null,
): Promise<{ productId: string; rate: string; quantity: number }[]> {
  if (saleTypeId === null) {
    const rows = await tx
      .select({ productId: products.id, mrp: products.mrp, quantity: stock.quantity })
      .from(stock).innerJoin(products, eq(products.id, stock.productId))
      .where(and(eq(stock.branchId, branchId), eq(products.isActive, true)));
    const explicit = await tx.select().from(stockByType).where(eq(stockByType.branchId, branchId));
    const byProduct = new Map<string, Map<string, number>>();
    for (const e of explicit) byProduct.set(e.productId, (byProduct.get(e.productId) ?? new Map()).set(e.saleTypeId, e.quantity));
    return rows.map((r) => ({
      productId: r.productId, rate: r.mrp,
      quantity: Math.max(0, r.quantity - explicitTotal(byProduct.get(r.productId) ?? new Map())),
    }));
  }
  const rows = await tx
    .select({ productId: products.id, mrp: products.mrp, quantity: stockByType.quantity, price: productPrices.price })
    .from(stockByType)
    .innerJoin(products, eq(products.id, stockByType.productId))
    .leftJoin(productPrices, and(eq(productPrices.productId, stockByType.productId), eq(productPrices.saleTypeId, saleTypeId)))
    .where(and(eq(stockByType.branchId, branchId), eq(stockByType.saleTypeId, saleTypeId), eq(products.isActive, true)));
  return rows.map((r) => ({ productId: r.productId, rate: r.price ?? r.mrp, quantity: r.quantity }));
}

/** Current bottles of ONE counter per product (default = total − other counters), for posting a sheet. */
async function currentCounterQuantities(
  tx: Tx | typeof db, branchId: string, saleTypeId: string | null, productIds: string[], lockRows: boolean,
): Promise<{ current: Map<string, number>; total: Map<string, number> }> {
  const totalQuery = tx.select().from(stock).where(and(eq(stock.branchId, branchId), inArray(stock.productId, productIds)));
  const totals = lockRows ? await totalQuery.for('update') : await totalQuery;
  const explicitRows = await tx.select().from(stockByType)
    .where(and(eq(stockByType.branchId, branchId), inArray(stockByType.productId, productIds)));
  const byProduct = new Map<string, Map<string, number>>();
  for (const e of explicitRows) byProduct.set(e.productId, (byProduct.get(e.productId) ?? new Map()).set(e.saleTypeId, e.quantity));
  const type = { id: saleTypeId ?? '', isDefault: saleTypeId === null };
  const current = new Map<string, number>();
  for (const t of totals) current.set(t.productId, counterQuantity(type, t.quantity, byProduct.get(t.productId) ?? new Map()));
  return { current, total: new Map(totals.map((t) => [t.productId, t.quantity])) };
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
export async function createSheet(user: JwtPayload, branchId: string, sheetDate: string, saleTypeId?: string | null) {
  if (sheetDate > businessDateOf()) throw new BusinessRuleError('Cannot create a counter sheet for a future date');
  const saleType = await resolveSaleType(db, branchId, saleTypeId);
  const typeId = rowTypeId(saleType);
  const dupMessage = saleType.isDefault ? 'A counter sheet already exists for this date' : `A ${saleType.name} counter sheet already exists for this date`;
  const { start, end } = businessDayBounds(sheetDate);
  const existingFor = () => db.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
    .where(and(eq(dailyCounterSheets.branchId, branchId), eq(dailyCounterSheets.sheetDate, sheetDate), typeIs(dailyCounterSheets.saleTypeId, typeId))).limit(1);
  try {
    const id = await db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
        .where(and(eq(dailyCounterSheets.branchId, branchId), eq(dailyCounterSheets.sheetDate, sheetDate), typeIs(dailyCounterSheets.saleTypeId, typeId))).limit(1);
      if (dup) throw new ConflictError(dupMessage, { sheetId: dup.id });

      const stocked = await counterStocks(tx, branchId, typeId);

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
          typeIs(dailyCounterSheets.saleTypeId, typeId),
          lt(dailyCounterSheets.sheetDate, sheetDate),
        ))
        .orderBy(dailyCounterSheetLines.productId, desc(dailyCounterSheets.sheetDate));
      // Opening carries the last posted closing forward plus the movements recorded on the days in
      // between (days without a sheet: inward, POS sales, voids, breakage, transfers), so none are lost.
      // Every figure here is for THIS counter only (stock_audit rows carry the sale type that moved).
      const gapMovement = new Map<string, Map<string, number>>();   // previous sheetDate → net movement per product
      for (const prevDate of new Set(previous.map((p) => p.sheetDate))) {
        gapMovement.set(prevDate, await movementByProduct(tx, branchId, businessDayBounds(prevDate).end, start, true, typeId));
      }
      const prevClosing = new Map(previous.map((p) => [
        p.productId,
        Math.max(0, p.closing + (gapMovement.get(p.sheetDate)?.get(p.productId) ?? 0)),
      ]));

      // Supplier invoices are received into the default counter; other counters get their bottles by transfer
      const inwardToday = typeId === null ? await inwardByProduct(tx, branchId, start, end) : new Map<string, number>();
      const transferToday = await transferByProduct(tx, branchId, start, end, typeId);
      const salesToday = await salesByProduct(tx, branchId, start, end, typeId);
      const movedSinceStart = await movementByProduct(tx, branchId, start, undefined, false, typeId);

      const [sheet] = await tx.insert(dailyCounterSheets).values({
        branchId,
        sheetDate,
        saleTypeId: typeId,
        status:      'DRAFT',
        createdById: user.sub,
      }).returning();

      if (stocked.length > 0) {
        const lineValues = stocked.map((p) => {
          const inward = inwardToday.get(p.productId) ?? 0;
          const transfer = transferToday.get(p.productId) ?? 0;
          const posSold = salesToday.get(p.productId)?.bottles ?? 0;
          const opening = prevClosing.get(p.productId)
            ?? Math.max(0, p.quantity - (movedSinceStart.get(p.productId) ?? 0));
          const closing = Math.max(0, opening + inward + transfer - posSold);
          const lineRes = computeLine(
            { opening, inward, closing, rate: p.rate, transfer },
            { allowAdjustment: true },
          );
          return {
            sheetId:        sheet.id,
            productId:      p.productId,
            openingBottles: opening,
            inwardBottles:  inward,
            transferBottles: transfer,
            closingBottles: closing,
            soldBottles:    lineRes.sold,
            sellingRate:    p.rate,
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
      const [existing] = await existingFor();
      throw new ConflictError(dupMessage, { sheetId: existing?.id });
    }
    throw err;
  }
}

// ─── UPDATE LINES ────────────────────────────────────────────────────────────

export async function updateSheetLines(user: JwtPayload, sheetId: string, input: UpdateLinesInput, canEditOpening = false) {
  const isManager = roleRank(user.role) >= ROLE_RANK.manager;
  const openingChanges: { productId: string; from: number; to: number }[] = [];

  const result = await db.transaction(async (tx) => {
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

      // The opening is worked out from yesterday's close; a shop that does not bill every sale may need to correct it
      const opening = input_.openingBottles ?? line.openingBottles;
      if (opening !== line.openingBottles && !canEditOpening) {
        throw new ForbiddenError('You do not have permission to change the opening stock. Ask the owner to give you "Change the opening stock on the counter sheet".');
      }
      const values = {
        opening,
        inward:  input_.inwardBottles ?? line.inwardBottles,
        closing: input_.closingBottles,
        rate:    line.sellingRate,
        transfer: line.transferBottles,
      };
      const surplus = violatesInvariant(values);
      if (surplus && input_.approveAdjustment && !isManager) {
        throw new BusinessRuleError(`Only a manager can approve the adjustment for product ${input_.productId}`);
      }
      const alreadyApproved = line.adjustmentApprovedById !== null && values.closing <= line.closingBottles && values.inward === line.inwardBottles;
      const allowAdjustment = (isManager && input_.approveAdjustment === true) || alreadyApproved;
      let result;
      try {
        result = computeLine(values, { allowAdjustment });
      } catch (err) {
        if (err instanceof CounterInvariantError) {
          throw new BusinessRuleError(`Product ${input_.productId}: ${err.message}`);
        }
        throw err;
      }

      // Remember what the system had worked out, and who changed it; putting it back clears the mark
      const systemOpening = line.openingSystem ?? line.openingBottles;
      const openingEdit = opening === line.openingBottles ? {} : (opening === systemOpening ? { openingSystem: null, openingEditedById: null } : { openingSystem: systemOpening, openingEditedById: user.sub });
      if (opening !== line.openingBottles) openingChanges.push({ productId: line.productId, from: line.openingBottles, to: opening });
      await tx.update(dailyCounterSheetLines).set({
        ...openingEdit,
        openingBottles:         opening,
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
  if (openingChanges.length > 0) {
    await logAudit(user.sub, 'counter.opening.edit', { type: 'counter_sheet', id: sheetId }, { changes: openingChanges });
  }
  return result;
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
        typeIs(dailyCounterSheets.saleTypeId, sheet.saleTypeId),
        gt(dailyCounterSheets.sheetDate, sheet.sheetDate),
      )).limit(1);
    if (later) throw new BusinessRuleError('A later counter sheet is already posted; this sheet would overwrite newer stock');

    const lines = await tx.select().from(dailyCounterSheetLines).where(eq(dailyCounterSheetLines.sheetId, sheetId));
    if (lines.length > 0) {
      const productIds = lines.map((l) => l.productId);
      // This counter's bottles only (default = total − the other counters); the shop total is locked too
      const { current } = await currentCounterQuantities(tx, sheet.branchId, sheet.saleTypeId, productIds, true);
      const movedAfter = await movementByProduct(tx, sheet.branchId, businessDayBounds(sheet.sheetDate).end, undefined, true, sheet.saleTypeId);

      const stockUpsertsMap = new Map<string, { branchId: string; productId: string; quantity: number }>();
      const stockAuditInserts: { branchId: string; productId: string; userId: string; changeQty: number; reason: 'COUNTER_SHEET'; referenceId: string; saleTypeId: string | null }[] = [];

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
            saleTypeId:  sheet.saleTypeId,
          });
        }
      }

      const stockUpserts = Array.from(stockUpsertsMap.values());
      if (stockUpserts.length > 0) {
        // ⚡ Bolt Optimization: Batch upsert stock records to prevent N+1 queries and DB lock contention
        await tx.insert(stock).values(stockUpserts)
          .onConflictDoUpdate({ target: [stock.branchId, stock.productId], set: { quantity: sql`${stock.quantity} + EXCLUDED.quantity` } });
        // A non-default counter keeps its own explicit count in step with the shop total
        if (sheet.saleTypeId) {
          await tx.insert(stockByType)
            .values(stockUpserts.map((u) => ({ ...u, saleTypeId: sheet.saleTypeId! })))
            .onConflictDoUpdate({
              target: [stockByType.branchId, stockByType.productId, stockByType.saleTypeId],
              set: { quantity: sql`${stockByType.quantity} + EXCLUDED.quantity` },
            });
        }
      }

      if (stockAuditInserts.length > 0) {
        // ⚡ Bolt Optimization: Batch insert stock audit records
        await tx.insert(stockAudit).values(stockAuditInserts);
      }

      await postUnbilledRevenue(tx, sheet, lines, user.sub);
    }
    return getSheet(sheetId, tx);
  });
}

/**
 * Books the revenue of bottles that left the counter without a POS bill:
 *   unbilled = sold on the sheet − sold through POS bills of this sale type that day − written off (breakage / damage)
 * at the counter's own rate (Walk-in = MRP, Janata = its price). Cash sale: Dr CASH, Cr SALES (+ OUTPUT_GST).
 * Bills already posted their own revenue, so nothing is counted twice.
 */
async function postUnbilledRevenue(tx: Tx, sheet: SheetRow, lines: (typeof dailyCounterSheetLines.$inferSelect)[], userId: string) {
  const { start, end } = businessDayBounds(sheet.sheetDate);
  const billed = await salesByProduct(tx, sheet.branchId, start, end, sheet.saleTypeId);
  const writtenOff = await writtenOffByProduct(tx, sheet.branchId, start, end, sheet.saleTypeId);
  const unbilled = lines
    .map((l) => ({
      productId: l.productId, rate: l.sellingRate,
      bottles: Math.max(0, l.soldBottles - (billed.get(l.productId)?.bottles ?? 0) - (writtenOff.get(l.productId) ?? 0)),
    }))
    .filter((u) => u.bottles > 0);
  if (unbilled.length === 0) return;

  const taxRows = await tx
    .select({ id: products.id, taxRate: categories.taxRate, gstRate: products.gstRate })
    .from(products).leftJoin(categories, eq(products.categoryId, categories.id))
    .where(inArray(products.id, unbilled.map((u) => u.productId)));
  const rates = new Map(taxRows.map((r) => [r.id, resolveTaxRate(r.taxRate, r.gstRate)]));
  const [type] = sheet.saleTypeId
    ? await tx.select({ name: saleTypes.name }).from(saleTypes).where(eq(saleTypes.id, sheet.saleTypeId)).limit(1)
    : [{ name: 'Walk-in' }];
  await postCounterSheetSales(tx, {
    branchId: sheet.branchId,
    sheetId: sheet.id,
    sheetDate: sheet.sheetDate,
    typeName: type?.name ?? 'Walk-in',
    userId,
    lines: unbilled.map((u) => ({ amount: new Decimal(u.rate).mul(u.bottles).toFixed(2), taxRate: rates.get(u.productId) ?? '0' })),
  });
}

/**
 * POSTED → DRAFT. Allowed ONLY if the sheet was posted on the current business day (same day).
 * Reverses the stock adjustments made by postSheet and removes the associated COUNTER_SHEET audit rows,
 * returning the sheet to DRAFT so counts can be corrected and reposted.
 */
export async function unpostSheet(user: JwtPayload, sheetId: string) {
  const isManager = roleRank(user.role) >= ROLE_RANK.manager;
  if (!isManager) {
    throw new BusinessRuleError('Only a manager can revert a posted counter sheet to draft');
  }

  return db.transaction(async (tx) => {
    const [sheet] = await tx.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, sheetId)).for('update');
    if (!sheet) throw new NotFoundError('Counter sheet not found');
    if (sheet.status !== 'POSTED') throw new ConflictError('Counter sheet is not in POSTED status');

    const today = businessDateOf();
    const postedDate = sheet.postedAt ? businessDateOf(sheet.postedAt) : null;
    const isSameDay = postedDate === today || sheet.sheetDate === today;

    if (!isSameDay) {
      throw new BusinessRuleError(
        `Counter sheet can only be reverted to draft on the day it was posted (posted: ${postedDate ?? sheet.sheetDate}, today: ${today})`,
      );
    }

    const [later] = await tx.select({ id: dailyCounterSheets.id }).from(dailyCounterSheets)
      .where(and(
        eq(dailyCounterSheets.branchId, sheet.branchId),
        eq(dailyCounterSheets.status, 'POSTED'),
        typeIs(dailyCounterSheets.saleTypeId, sheet.saleTypeId),
        gt(dailyCounterSheets.sheetDate, sheet.sheetDate),
      )).limit(1);
    if (later) throw new BusinessRuleError('A later counter sheet is already posted; cannot revert this sheet');

    // 1. Find all stock_audit rows written by this sheet post
    const audits = await tx.select().from(stockAudit)
      .where(and(
        eq(stockAudit.branchId, sheet.branchId),
        eq(stockAudit.reason, 'COUNTER_SHEET'),
        eq(stockAudit.referenceId, sheet.id),
      ));

    // 2. Reverse stock changes
    const validAudits = audits.filter(a => a.changeQty !== 0);
    if (validAudits.length > 0) {
      // ⚡ Bolt Optimization: Batch update stock with CASE WHEN
      // Replaces O(N) sequential database updates with a single query.
      // Impact: Eliminates N+1 queries when reverting counter sheets, massively reducing DB lock contention and transaction duration.
      const caseSql = sql`CAST(CASE ${sql.join(
        validAudits.map((a) => sql`WHEN ${stock.productId} = ${a.productId} THEN ${a.changeQty}`),
        sql` `
      )} END AS integer)`;
      await tx.update(stock)
        .set({ quantity: sql`${stock.quantity} - ${caseSql}` })
        .where(and(eq(stock.branchId, sheet.branchId), inArray(stock.productId, validAudits.map(a => a.productId))));

      // A non-default counter's own count goes back in step with the shop total
      if (sheet.saleTypeId) {
        const typeCase = sql`CAST(CASE ${sql.join(
          validAudits.map((a) => sql`WHEN ${stockByType.productId} = ${a.productId} THEN ${a.changeQty}`),
          sql` `
        )} END AS integer)`;
        await tx.update(stockByType)
          .set({ quantity: sql`${stockByType.quantity} - ${typeCase}` })
          .where(and(
            eq(stockByType.branchId, sheet.branchId),
            eq(stockByType.saleTypeId, sheet.saleTypeId),
            inArray(stockByType.productId, validAudits.map((a) => a.productId)),
          ));
        const [negType] = await tx.select({ productId: stockByType.productId, quantity: stockByType.quantity }).from(stockByType)
          .where(and(
            eq(stockByType.branchId, sheet.branchId), eq(stockByType.saleTypeId, sheet.saleTypeId),
            inArray(stockByType.productId, validAudits.map((a) => a.productId)), lt(stockByType.quantity, 0),
          )).limit(1);
        if (negType) throw new BusinessRuleError(`Cannot revert sheet: product ${negType.productId} counter would become negative (${negType.quantity})`);
      }
    }

    // Check if any stock became negative
    if (audits.length > 0) {
      const [neg] = await tx.select({ productId: stock.productId, quantity: stock.quantity })
        .from(stock)
        .where(and(
          eq(stock.branchId, sheet.branchId),
          inArray(stock.productId, audits.map((a) => a.productId)),
          lt(stock.quantity, 0),
        ))
        .limit(1);
      if (neg) {
        throw new BusinessRuleError(`Cannot revert sheet: product ${neg.productId} stock would become negative (${neg.quantity})`);
      }

      // 3. Remove the COUNTER_SHEET audit rows
      await tx.delete(stockAudit)
        .where(and(
          eq(stockAudit.branchId, sheet.branchId),
          eq(stockAudit.reason, 'COUNTER_SHEET'),
          eq(stockAudit.referenceId, sheet.id),
        ));
    }

    // The default counter (shop total − other counters) may not go negative either
    if (!sheet.saleTypeId && audits.length > 0) {
      const ids = audits.map((a) => a.productId);
      const reserved = await explicitSums(tx, sheet.branchId, ids);
      const totals = await tx.select({ productId: stock.productId, quantity: stock.quantity }).from(stock)
        .where(and(eq(stock.branchId, sheet.branchId), inArray(stock.productId, ids)));
      const bad = totals.find((t) => t.quantity < (reserved.get(t.productId) ?? 0));
      if (bad) throw new BusinessRuleError(`Cannot revert sheet: product ${bad.productId} would drop below the bottles held by other counters`);
    }

    // The revenue booked for bottles sold without a POS bill is reversed with the sheet
    await reverseCounterSheetSales(tx, { branchId: sheet.branchId, sheetId: sheet.id, sheetDate: sheet.sheetDate, userId: user.sub });

    // 4. Update sheet status back to DRAFT
    await tx.update(dailyCounterSheets).set({
      status:     'DRAFT',
      postedById: null,
      postedAt:   null,
    }).where(eq(dailyCounterSheets.id, sheet.id));

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
export async function syncSheetWithSales(sheetId: string, txHandle?: Tx, targetProductIds?: string[]) {
  const runner = async (tx: Tx) => {
    const [sheet] = await tx.select().from(dailyCounterSheets).where(eq(dailyCounterSheets.id, sheetId)).limit(1);
    if (!sheet) throw new NotFoundError('Counter sheet not found');
    if (sheet.status !== 'DRAFT') throw new BusinessRuleError('Cannot sync a posted counter sheet');

    const { start, end } = businessDayBounds(sheet.sheetDate);
    // If targetProductIds is supplied (e.g. from a bill sale), only calculate lines for those products
    const hasTargets = targetProductIds && targetProductIds.length > 0;
    // three independent reads: one round trip, not three
    const [inwardMap, transferMap, salesMap] = await Promise.all([
      sheet.saleTypeId === null ? inwardByProduct(tx, sheet.branchId, start, end, targetProductIds) : Promise.resolve(new Map<string, number>()),
      transferByProduct(tx, sheet.branchId, start, end, sheet.saleTypeId, targetProductIds),
      salesByProduct(tx, sheet.branchId, start, end, sheet.saleTypeId, targetProductIds),
    ]);

    const lineConditions = [eq(dailyCounterSheetLines.sheetId, sheetId)];
    if (hasTargets) {
      lineConditions.push(inArray(dailyCounterSheetLines.productId, targetProductIds!));
    }
    const lines = await tx
      .select()
      .from(dailyCounterSheetLines)
      .where(and(...lineConditions));

    // Only discover missing stocked products when doing a full sync (not a targeted single-bill update)
    if (!hasTargets) {
      const existingProductIds = new Set(lines.map((l) => l.productId));
      const stocked = await counterStocks(tx, sheet.branchId, sheet.saleTypeId);
      const missingStocked = stocked.filter((s) => !existingProductIds.has(s.productId));
      if (missingStocked.length > 0) {
        const newLineValues = missingStocked.map((p) => {
          const inward = inwardMap.get(p.productId) ?? 0;
          const transfer = transferMap.get(p.productId) ?? 0;
          const posSold = salesMap.get(p.productId)?.bottles ?? 0;
          const opening = Math.max(0, p.quantity - inward - transfer + posSold);
          const closing = Math.max(0, opening + inward + transfer - posSold);
          const lineRes = computeLine(
            { opening, inward, closing, rate: p.rate, transfer },
            { allowAdjustment: true },
          );
          return {
            sheetId:        sheet.id,
            productId:      p.productId,
            openingBottles: opening,
            inwardBottles:  inward,
            transferBottles: transfer,
            closingBottles: closing,
            soldBottles:    lineRes.sold,
            sellingRate:    p.rate,
            lineRevenue:    lineRes.revenue,
          };
        });
        await tx.insert(dailyCounterSheetLines).values(newLineValues);
      }
    }

    const updates = lines.map((l) => {
      const inward = inwardMap.get(l.productId) ?? l.inwardBottles;
      const transfer = transferMap.get(l.productId) ?? 0;
      const posSold = salesMap.get(l.productId)?.bottles ?? 0;
      const available = l.openingBottles + inward + transfer;
      const closing = Math.max(0, available - posSold);
      const res = computeLine(
        { opening: l.openingBottles, inward, closing, rate: l.sellingRate, transfer },
        { allowAdjustment: true },
      );
      return { id: l.id, inward, transfer, closing, sold: res.sold, revenue: res.revenue };
    });

    if (updates.length > 0) {
      const inwardCase = sql`CAST(CASE ${sql.join(updates.map((u) => sql`WHEN ${dailyCounterSheetLines.id} = ${u.id} THEN ${u.inward}`), sql` `)} END AS integer)`;
      const transferCase = sql`CAST(CASE ${sql.join(updates.map((u) => sql`WHEN ${dailyCounterSheetLines.id} = ${u.id} THEN ${u.transfer}`), sql` `)} END AS integer)`;
      const closingCase = sql`CAST(CASE ${sql.join(updates.map((u) => sql`WHEN ${dailyCounterSheetLines.id} = ${u.id} THEN ${u.closing}`), sql` `)} END AS integer)`;
      const soldCase = sql`CAST(CASE ${sql.join(updates.map((u) => sql`WHEN ${dailyCounterSheetLines.id} = ${u.id} THEN ${u.sold}`), sql` `)} END AS integer)`;
      const revCase = sql`CAST(CASE ${sql.join(updates.map((u) => sql`WHEN ${dailyCounterSheetLines.id} = ${u.id} THEN ${u.revenue}`), sql` `)} END AS numeric(12,2))`;

      await tx
        .update(dailyCounterSheetLines)
        .set({
          inwardBottles:  inwardCase,
          transferBottles: transferCase,
          closingBottles: closingCase,
          soldBottles:    soldCase,
          lineRevenue:    revCase,
        })
        .where(inArray(dailyCounterSheetLines.id, updates.map((u) => u.id)));
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
 * Automatically updates the open (DRAFT) counter sheet of this branch, business date and sale type
 * when a bill is paid or voided, a supplier invoice is approved or stock is moved between counters.
 * `saleTypeId` null = the default sale type's sheet.
 */
export async function onBillPaidOrVoided(branchId: string, eventDate: Date, tx: Tx, saleTypeId: string | null = null, productIds?: string[]) {
  const sheetDate = businessDateOf(eventDate);
  const [draftSheet] = await tx
    .select({ id: dailyCounterSheets.id })
    .from(dailyCounterSheets)
    .where(
      and(
        eq(dailyCounterSheets.branchId, branchId),
        eq(dailyCounterSheets.sheetDate, sheetDate),
        eq(dailyCounterSheets.status, 'DRAFT'),
        typeIs(dailyCounterSheets.saleTypeId, saleTypeId),
      ),
    )
    .limit(1);

  if (draftSheet) {
    await syncSheetWithSales(draftSheet.id, tx, productIds);
  }
}

/** Re-syncs the open sheets of the given counters for a day (used after a transfer between counters). */
export async function syncDraftSheetsFor(branchId: string, businessDate: string, saleTypeIds: (string | null)[]): Promise<void> {
  const when = businessDayBounds(businessDate).start;
  await db.transaction(async (tx) => {
    for (const id of new Set(saleTypeIds)) await onBillPaidOrVoided(branchId, when, tx, id);
  });
}

let counterUnsubscribers: (() => void)[] | null = null;

export function registerCounterSheetHandlers(): void {
  if (counterUnsubscribers) return;
  counterUnsubscribers = [
    onDomainEvent('bill.paid', async ({ bill, items }, tx) => {
      const prodIds = items?.map((i) => i.productId).filter(Boolean);
      await onBillPaidOrVoided(bill.branchId, bill.createdAt ?? new Date(), tx, bill.saleTypeId ?? null, prodIds);
    }),
    onDomainEvent('bill.voided', async ({ bill }, tx) => {
      await onBillPaidOrVoided(bill.branchId, bill.createdAt ?? new Date(), tx, bill.saleTypeId ?? null);
    }),
    onDomainEvent('supplierInvoice.approved', async ({ invoice }, tx) => {
      await onBillPaidOrVoided(invoice.branchId, invoice.approvedAt ?? new Date(), tx, null);
    }),
    onDomainEvent('supplierInvoice.reversed', async ({ invoice }, tx) => {
      await onBillPaidOrVoided(invoice.branchId, invoice.approvedAt ?? new Date(), tx, null);
    }),
  ];
}

export function unregisterCounterSheetHandlers(): void {
  for (const off of counterUnsubscribers ?? []) off();
  counterUnsubscribers = null;
}
