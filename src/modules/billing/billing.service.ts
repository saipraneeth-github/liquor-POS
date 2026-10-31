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
  categories,
  customers,
  creditTransactions,
  shiftSessions,
} from '../../db/schema.js';
import { eq, inArray, and, gte, lt, ne, desc, sql } from 'drizzle-orm';
import { calculateBill, mergeBillItems, resolveTaxRate, formatBillNumber } from './billing.engine.js';
import { checkStockAvailability, computeStockDeltas, computeVoidStockDeltas } from '../stock/stock.engine.js';
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
  clientRef:   z.string().trim().min(1).max(64).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
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

  // 2. Price from DB (MRP, tax-inclusive) — never from the client
  const calculation = calculateBill(
    items.map((item) => {
      const product = productMap.get(item.productId)!;
      return {
        productId: item.productId,
        quantity:  item.quantity,
        unitPrice: product.mrp,
        taxRate:   resolveTaxRate(product.taxRate),
      };
    }),
    input.discount,
  );

  // 3. Friendly stock pre-check (the in-transaction guarded UPDATE is authoritative)
  const stockEntries = await db
    .select({ productId: stock.productId, quantity: stock.quantity })
    .from(stock)
    .where(and(eq(stock.branchId, input.branchId), inArray(stock.productId, productIds)));
  const shortages = checkStockAvailability(items, new Map(stockEntries.map((s) => [s.productId, s.quantity])));
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
        })),
      ).returning();

      // Guarded, atomic stock deduction (sorted to keep lock order stable)
      const deltas = computeStockDeltas(items).sort((a, b) => a.productId.localeCompare(b.productId));
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

    // Reverse stock atomically; recreate a missing stock row
    const deltas = computeVoidStockDeltas(items).sort((a, b) => a.productId.localeCompare(b.productId));
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
