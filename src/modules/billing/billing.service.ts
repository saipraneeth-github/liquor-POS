import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  bills,
  billItems,
  billCounters,
  stock,
  stockAudit,
  branches,
  products,
  productServings,
  categories,
  customers,
  creditTransactions,
  shiftSessions,
} from '../../db/schema.js';
import { eq, inArray, and, gte, lt, ne, desc, sql } from 'drizzle-orm';
import { calculateBill, mergeBillItems, resolveTaxRate, formatBillNumber } from './billing.engine.js';
import { checkStockAvailability, computeStockDeltas, computeVoidStockDeltas } from '../stock/stock.engine.js';
import { deductMl, restoreMl, splitUnitsAndMl } from '../menu/serving.engine.js';
import { assertBranchCanSell } from '../menu/menu-access.js';
import { assertCreditAvailable, applyCreditPurchase, applyCreditReversal } from '../customers/credit.engine.js';
import { emitDomainEvent, type Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { businessDateOf, businessDayBounds, isIsoDate } from '../../lib/business-day.js';
import type { JwtPayload } from '../auth/auth.service.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const PAYMENT_MODES = ['CASH', 'CARD', 'UPI', 'CREDIT'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const CreateBillSchema = z.object({
  branchId:    z.string().uuid(),
  paymentMode: z.enum(PAYMENT_MODES),
  discount:    z.string().regex(/^\d+(\.\d{1,2})?$/).optional().default('0'),
  customerId:  z.string().uuid().optional(),
  roundOff:    z.boolean().optional(),   // overrides the branch setting for this bill
  customerGstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 alphanumeric characters').optional(),
  clientRef:   z.string().trim().min(1).max(64).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    servingId: z.string().uuid().optional(),   // peg / glass serving; omit for the product's own rate
    quantity:  z.number().int().positive().max(10_000),
  })).min(1).max(500),
}).refine((d) => d.paymentMode !== 'CREDIT' || !!d.customerId, {
  message: 'customerId is required for CREDIT bills',
  path: ['customerId'],
});

export const VoidBillSchema = z.object({
  voidReason: z.string().trim().min(5).max(500),
});

export const ListBillsQuerySchema = z.object({
  branchId: z.string().uuid(),
  date:     z.string().refine(isIsoDate, 'date must be YYYY-MM-DD').optional(),
  status:   z.enum(['OPEN', 'PAID', 'VOIDED']).optional(),
  limit:    z.coerce.number().int().min(1).max(200).default(50),
  offset:   z.coerce.number().int().min(0).default(0),
});

export type CreateBillInput = z.infer<typeof CreateBillSchema>;
export type ListBillsQuery = z.infer<typeof ListBillsQuerySchema>;
export type BillRow = typeof bills.$inferSelect;
export type BillItemRow = typeof billItems.$inferSelect;

// ─── BILL NUMBER GENERATOR ───────────────────────────────────────────────────

/** Atomic per-branch, per-year sequence via bill_counters upsert (safe under concurrency). */
async function generateBillNumber(branchId: string, tx: Tx): Promise<string> {
  const [branch] = await tx
    .select({ code: branches.code })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  if (!branch) throw new NotFoundError('Branch not found');

  // Business-day year (store time zone), not the server's local clock
  const year = Number(businessDateOf().slice(0, 4));
  const [counter] = await tx
    .insert(billCounters)
    .values({ branchId, year, lastSeq: 1 })
    .onConflictDoUpdate({
      target: [billCounters.branchId, billCounters.year],
      set: { lastSeq: sql`${billCounters.lastSeq} + 1` },
    })
    .returning({ lastSeq: billCounters.lastSeq });

  return formatBillNumber(branch.code, year, counter.lastSeq);
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function findBillByClientRef(clientRef: string) {
  const [existing] = await db.select().from(bills).where(eq(bills.clientRef, clientRef)).limit(1);
  if (!existing) return null;
  const items = await db.select().from(billItems).where(eq(billItems.billId, existing.id));
  return { ...existing, items };
}

function idempotentReplay(existing: BillRow & { items: BillItemRow[] }, input: CreateBillInput) {
  if (existing.branchId !== input.branchId) {
    throw new ConflictError('clientRef already used for a bill in another branch');
  }
  return { bill: existing, created: false as const };
}

// ─── BILLING SERVICE ─────────────────────────────────────────────────────────

/**
 * Creates a PAID bill. Returns `created: false` when `clientRef` matched an existing bill
 * (idempotent offline sync).
 */
export async function createBill(
  input: CreateBillInput,
  cashier: JwtPayload,
): Promise<{ bill: BillRow & { items: BillItemRow[] }; created: boolean }> {
  // 0. Idempotency: replay existing bill for the same clientRef
  if (input.clientRef) {
    const existing = await findBillByClientRef(input.clientRef);
    if (existing) return idempotentReplay(existing, input);
  }

  // 1. Merge duplicate lines, load products + category tax in ONE query
  const items = mergeBillItems(input.items);
  const productIds = items.map((i) => i.productId);
  const productRows = await db
    .select({
      id:       products.id,
      name:     products.name,
      mrp:      products.mrp,
      isActive: products.isActive,
      taxRate:  categories.taxRate,
      gstRate:     products.gstRate,
      isAvailable: products.isAvailable,
      trackStock:  products.trackStock,
      volumeMl:    products.volumeMl,
      syndicateId: products.syndicateId,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(inArray(products.id, productIds));

  const productMap = new Map(productRows.map((p) => [p.id, p]));
  const missing = productIds.filter((id) => !productMap.has(id));
  if (missing.length > 0) {
    throw new BusinessRuleError(`One or more products not found: ${missing.join(', ')}`);
  }
  const inactive = productRows.filter((p) => !p.isActive);
  if (inactive.length > 0) {
    throw new BusinessRuleError(`Inactive products cannot be billed: ${inactive.map((p) => p.name).join(', ')}`);
  }

  await assertBranchCanSell(db, input.branchId, productRows);
  const [branchSettings] = await db.select({ roundOff: branches.roundOff }).from(branches).where(eq(branches.id, input.branchId)).limit(1);

  // Servings (peg / glass / full bottle) must belong to their product and be active
  const servingIds = [...new Set(items.flatMap((i) => (i.servingId ? [i.servingId] : [])))];
  const servingRows = servingIds.length
    ? await db.select().from(productServings).where(inArray(productServings.id, servingIds))
    : [];
  const servingMap = new Map(servingRows.map((s) => [s.id, s]));
  for (const item of items) {
    if (!item.servingId) continue;
    const s = servingMap.get(item.servingId);
    if (!s || s.productId !== item.productId || !s.isActive) {
      throw new BusinessRuleError(`Serving not available for product ${item.productId}`);
    }
    if (s.volumeMl && !productMap.get(item.productId)!.volumeMl) {
      throw new BusinessRuleError(`Product ${item.productId} has no bottle size, so it cannot be sold by the peg`);
    }
  }

  // 2. Price from DB (serving rate or MRP, tax-inclusive) — never from the client
  const calculation = calculateBill(
    items.map((item) => {
      const product = productMap.get(item.productId)!;
      const serving = item.servingId ? servingMap.get(item.servingId)! : undefined;
      return {
        productId: item.productId,
        quantity:  item.quantity,
        unitPrice: serving?.price ?? product.mrp,
        taxRate:   resolveTaxRate(product.taxRate, product.gstRate),
        servingId:    serving?.id ?? null,
        servingLabel: serving?.label ?? null,
        servingMl:    serving?.volumeMl ?? null,
      };
    }),
    input.discount,
    input.roundOff ?? branchSettings?.roundOff ?? false,
  );

  // Stock only moves for stock-tracked products (kitchen items are not). Whole units deduct
  // bottles; peg servings deduct ml from the open bottle.
  const { units, ml: mlByProduct } = splitUnitsAndMl(
    items
      .filter((i) => productMap.get(i.productId)!.trackStock)
      .map((i) => ({
        productId: i.productId,
        quantity:  i.quantity,
        servingMl: i.servingId ? servingMap.get(i.servingId)!.volumeMl : null,
      })),
  );
  const unitItems = [...units].map(([productId, quantity]) => ({ productId, quantity }));

  // 3. Friendly stock pre-check (the in-transaction guarded UPDATE is authoritative)
  const stockEntries = unitItems.length === 0 ? [] : await db
    .select({ productId: stock.productId, quantity: stock.quantity })
    .from(stock)
    .where(and(eq(stock.branchId, input.branchId), inArray(stock.productId, unitItems.map((u) => u.productId))));
  const shortages = checkStockAvailability(unitItems, new Map(stockEntries.map((s) => [s.productId, s.quantity])));
  if (shortages.length > 0) {
    throw new BusinessRuleError(
      `Insufficient stock: ${shortages
        .map((s) => `product ${s.productId} (requested ${s.requested}, available ${s.available})`)
        .join(', ')}`,
    );
  }

  // 4. Transaction: number, bill, items, guarded stock deduction, audit, credit, event
  try {
    const created = await db.transaction(async (tx) => {
      const billNumber = await generateBillNumber(input.branchId, tx);
      const now = new Date();

      // Link to the cashier's open shift in this branch (if any). FOR SHARE blocks a concurrent
      // shift close until this bill commits, so the close always sees it in its totals.
      const [shift] = await tx
        .select({ id: shiftSessions.id })
        .from(shiftSessions)
        .where(and(
          eq(shiftSessions.branchId, input.branchId),
          eq(shiftSessions.cashierId, cashier.sub),
          eq(shiftSessions.status, 'OPEN'),
        ))
        .orderBy(desc(shiftSessions.openedAt))
        .limit(1)
        .for('share');

      // Credit (khata) check — lock the customer row
      let customer: typeof customers.$inferSelect | undefined;
      if (input.paymentMode === 'CREDIT') {
        [customer] = await tx
          .select()
          .from(customers)
          .where(eq(customers.id, input.customerId!))
          .for('update');
        if (!customer || customer.branchId !== input.branchId) {
          throw new BusinessRuleError('Customer not found in this branch');
        }
        if (!customer.isActive) throw new BusinessRuleError('Customer is inactive');
        if (!customer.creditAllowed) throw new BusinessRuleError('Credit is not allowed for this customer');
        assertCreditAvailable(customer.currentCredit, customer.creditLimit, calculation.total);
      }

      const [bill] = await tx.insert(bills).values({
        branchId:       input.branchId,
        cashierId:      cashier.sub,
        billNumber,
        status:         'PAID',
        subtotal:       calculation.subtotal,
        taxAmount:      calculation.taxAmount,
        discount:       calculation.discount,
        roundOff:       calculation.roundOff,
        customerGstin:  input.customerGstin ?? customer?.gstin ?? null,
        total:          calculation.total,
        paymentMode:    input.paymentMode,
        customerId:     customer?.id ?? null,   // only validated (CREDIT) customers are linked
        shiftSessionId: shift?.id ?? null,
        clientRef:      input.clientRef ?? null,
        paidAt:         now,
      }).returning();

      const insertedItems = await tx.insert(billItems).values(
        calculation.lines.map((line) => ({
          billId:    bill.id,
          productId: line.productId,
          quantity:  line.quantity,
          unitPrice: line.unitPrice,
          taxRate:   line.taxRate,
          taxAmount: line.taxAmount,
          lineTotal: line.lineTotal,
          servingId:    line.servingId,
          servingLabel: line.servingLabel,
          servingMl:    line.servingMl,
        })),
      ).returning();

      // Guarded, atomic stock deduction (sorted to keep lock order stable)
      const deltas = computeStockDeltas(unitItems).sort((a, b) => a.productId.localeCompare(b.productId));
      if (deltas.length > 0) {
        // ⚡ Bolt Optimization: Batch update stock with CASE WHEN
        // Replaces O(N) sequential database updates with a single query.
        // Impact: Eliminates N+1 queries during billing, massively reducing DB lock contention and transaction duration.
        const caseSql = sql`CAST(CASE ${sql.join(
          deltas.map((d) => sql`WHEN ${stock.productId} = ${d.productId} THEN ${-d.delta}`),
          sql` `
        )} END AS integer)`;

        const updated = await tx
          .update(stock)
          .set({ quantity: sql`${stock.quantity} - ${caseSql}` })
          .where(and(
            eq(stock.branchId, input.branchId),
            inArray(stock.productId, deltas.map((d) => d.productId)),
            sql`${stock.quantity} >= ${caseSql}`
          ))
          .returning({ productId: stock.productId });

        if (updated.length !== deltas.length) {
          const updatedIds = new Set(updated.map((u) => u.productId));
          const missing = deltas.find((d) => !updatedIds.has(d.productId));
          if (missing) {
            throw new BusinessRuleError(`Insufficient stock: product ${missing.productId} (requested ${-missing.delta})`);
          }
        }
      }

      if (deltas.length > 0) {
        await tx.insert(stockAudit).values(
          deltas.map((d) => ({
            branchId:    input.branchId,
            productId:   d.productId,
            userId:      cashier.sub,
            changeQty:   d.delta,
            reason:      'SALE' as const,
            referenceId: bill.id,
          })),
        );
      }

      // Peg sales: draw ml from the open bottle, opening sealed bottles as needed
      for (const [productId, totalMl] of [...mlByProduct].sort(([a], [b]) => a.localeCompare(b))) {
        const product = productMap.get(productId)!;
        const [row] = await tx
          .select({ quantity: stock.quantity, openMl: stock.openMl })
          .from(stock)
          .where(and(eq(stock.branchId, input.branchId), eq(stock.productId, productId)))
          .for('update');
        const result = row ? deductMl(row, totalMl, product.volumeMl!) : null;
        if (!result) throw new BusinessRuleError(`Insufficient stock: ${product.name} (${totalMl} ml requested)`);
        await tx.update(stock)
          .set({ quantity: result.state.quantity, openMl: result.state.openMl })
          .where(and(eq(stock.branchId, input.branchId), eq(stock.productId, productId)));
        await tx.insert(stockAudit).values({
          branchId:    input.branchId,
          productId,
          userId:      cashier.sub,
          changeQty:   -result.bottlesOpened,
          changeMl:    -totalMl,
          reason:      'SALE' as const,
          referenceId: bill.id,
        });
      }

      if (customer) {
        const balanceAfter = applyCreditPurchase(customer.currentCredit, calculation.total);
        await tx.update(customers).set({ currentCredit: balanceAfter }).where(eq(customers.id, customer.id));
        await tx.insert(creditTransactions).values({
          customerId:   customer.id,
          type:         'PURCHASE',
          amount:       calculation.total,
          balanceAfter,
          billId:       bill.id,
          recordedById: cashier.sub,
          notes:        `Bill ${bill.billNumber}`,
        });
      }

      await emitDomainEvent('bill.paid', { bill, items: insertedItems }, tx);

      return { ...bill, items: insertedItems };
    });
    return { bill: created, created: true };
  } catch (err) {
    // Lost a race on the same clientRef → replay the winner
    if (input.clientRef && isUniqueViolation(err)) {
      const existing = await findBillByClientRef(input.clientRef);
      if (existing) return idempotentReplay(existing, input);
    }
    throw err;
  }
}

// ─── VOID BILL ───────────────────────────────────────────────────────────────

export async function voidBill(
  billId: string,
  voidReason: string,
  user: JwtPayload,
): Promise<BillRow> {
  return db.transaction(async (tx) => {
    // Race-free status flip: only one void can win
    const [bill] = await tx
      .update(bills)
      .set({ status: 'VOIDED', voidedAt: new Date(), voidReason })
      .where(and(eq(bills.id, billId), ne(bills.status, 'VOIDED')))
      .returning();

    if (!bill) {
      const [exists] = await tx.select({ id: bills.id }).from(bills).where(eq(bills.id, billId)).limit(1);
      if (!exists) throw new NotFoundError('Bill not found');
      throw new BusinessRuleError('Bill is already voided');
    }

    const items = await tx.select().from(billItems).where(eq(billItems.billId, billId));

    // Only stock-tracked products were deducted at sale time
    const soldProducts = await tx
      .select({ id: products.id, trackStock: products.trackStock, volumeMl: products.volumeMl })
      .from(products)
      .where(inArray(products.id, [...new Set(items.map((i) => i.productId))]));
    const tracked = new Map(soldProducts.map((p) => [p.id, p]));
    const trackedItems = items.filter((i) => tracked.get(i.productId)?.trackStock);
    const { units: voidUnits, ml: voidMl } = splitUnitsAndMl(
      trackedItems.map((i) => ({ productId: i.productId, quantity: i.quantity, servingMl: i.servingMl })),
    );

    // Reverse stock atomically; recreate a missing stock row
    const deltas = computeVoidStockDeltas([...voidUnits].map(([productId, quantity]) => ({ productId, quantity })))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    for (const [productId, totalMl] of [...voidMl].sort(([a], [b]) => a.localeCompare(b))) {
      const bottleMl = tracked.get(productId)!.volumeMl!;
      const [row] = await tx
        .select({ quantity: stock.quantity, openMl: stock.openMl })
        .from(stock)
        .where(and(eq(stock.branchId, bill.branchId), eq(stock.productId, productId)))
        .for('update');
      const restored = restoreMl(row ?? { quantity: 0, openMl: 0 }, totalMl, bottleMl);
      await tx.insert(stock)
        .values({ branchId: bill.branchId, productId, quantity: restored.quantity, openMl: restored.openMl })
        .onConflictDoUpdate({
          target: [stock.branchId, stock.productId],
          set: { quantity: restored.quantity, openMl: restored.openMl },
        });
      await tx.insert(stockAudit).values({
        branchId:    bill.branchId,
        productId,
        userId:      user.sub,
        changeQty:   restored.quantity - (row?.quantity ?? 0),
        changeMl:    totalMl,
        reason:      'VOID_REVERSAL' as const,
        referenceId: billId,
      });
    }

    if (deltas.length > 0) {
      await tx
        .insert(stock)
        .values(deltas.map((delta) => ({ branchId: bill.branchId, productId: delta.productId, quantity: delta.delta })))
        .onConflictDoUpdate({
          target: [stock.branchId, stock.productId],
          set: { quantity: sql`${stock.quantity} + EXCLUDED.quantity` },
        });

      await tx.insert(stockAudit).values(
        deltas.map((d) => ({
          branchId:    bill.branchId,
          productId:   d.productId,
          userId:      user.sub,
          changeQty:   d.delta,
          reason:      'VOID_REVERSAL' as const,
          referenceId: billId,
        })),
      );
    }

    // Reverse khata credit
    if (bill.paymentMode === 'CREDIT' && bill.customerId) {
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, bill.customerId))
        .for('update');
      if (customer) {
        const balanceAfter = applyCreditReversal(customer.currentCredit, bill.total);
        await tx.update(customers).set({ currentCredit: balanceAfter }).where(eq(customers.id, customer.id));
        await tx.insert(creditTransactions).values({
          customerId:   customer.id,
          type:         'ADJUSTMENT',
          amount:       bill.total,
          balanceAfter,
          billId:       bill.id,
          recordedById: user.sub,
          notes:        `Void of bill ${bill.billNumber}: ${voidReason}`,
        });
      }
    }

    await emitDomainEvent('bill.voided', { bill, items, voidedById: user.sub }, tx);

    return bill;
  });
}

// ─── BILL LOOKUP ─────────────────────────────────────────────────────────────

export async function getBillHeader(billId: string) {
  const [bill] = await db.select().from(bills).where(eq(bills.id, billId)).limit(1);
  return bill ?? null;
}

export async function getBillById(billId: string) {
  const bill = await getBillHeader(billId);
  if (!bill) return null;

  const items = await db
    .select()
    .from(billItems)
    .where(eq(billItems.billId, billId));

  return { ...bill, items };
}

/** Paginated bill history for a branch, newest first. */
export async function listBills(query: ListBillsQuery) {
  const conditions = [eq(bills.branchId, query.branchId)];
  if (query.status) conditions.push(eq(bills.status, query.status));
  if (query.date) {
    const { start, end } = businessDayBounds(query.date);
    conditions.push(gte(bills.createdAt, start), lt(bills.createdAt, end));
  }
  const where = and(...conditions);

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(bills).where(where)
      .orderBy(desc(bills.createdAt), desc(bills.billNumber))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(bills).where(where),
  ]);

  return { bills: rows, total: Number(count), limit: query.limit, offset: query.offset };
}
