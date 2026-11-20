import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  billItems, bills, branches, branchProductCosts, creditTransactions, customers, products, purchaseReturnItems, purchaseReturns,
  salesReturnItems, salesReturns, stock, stockAudit,
} from '../../db/schema.js';
import { emitDomainEvent } from '../../lib/domain-events.js';
import { addStockDeltas } from '../../lib/stock-delta.js';
import { assertBusinessDayOpen } from '../../lib/closed-day.js';
import { logAudit } from '../../lib/audit.js';
import { businessDateOf } from '../../lib/business-day.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { applyCreditReversal } from '../customers/credit.engine.js';
import { planSalesReturn, purchaseReturnTotal } from './return.engine.js';

const number = (prefix: string) => `${prefix}-${businessDateOf().replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;

// ─── CUSTOMER RETURN (credit note) ───────────────────────────────────────────────

export const SalesReturnSchema = z.object({
  reason: z.string().trim().min(5, 'Say why the bottles are coming back').max(300),
  items: z.array(z.object({ billItemId: z.string().uuid(), quantity: z.number().int().min(1).max(100_000) })).min(1).max(200),
});

/** What has already come back from each line of a bill. */
async function returnedByItem(runner: typeof db, billItemIds: string[]) {
  if (billItemIds.length === 0) return new Map<string, { qty: number; gross: string; tax: string }>();
  const rows = await runner
    .select({
      billItemId: salesReturnItems.billItemId, qty: sql<number>`sum(${salesReturnItems.quantity})::int`,
      gross: sql<string>`sum(${salesReturnItems.grossAmount})::text`, tax: sql<string>`sum(${salesReturnItems.taxAmount})::text`,
    })
    .from(salesReturnItems).where(inArray(salesReturnItems.billItemId, billItemIds)).groupBy(salesReturnItems.billItemId);
  return new Map(rows.map((r) => [r.billItemId, { qty: Number(r.qty), gross: r.gross, tax: r.tax }]));
}

export async function createSalesReturn(billId: string, input: z.infer<typeof SalesReturnSchema>, user: JwtPayload) {
  const [head] = await db.select({ branchId: bills.branchId, status: bills.status }).from(bills).where(eq(bills.id, billId)).limit(1);
  if (!head) throw new NotFoundError('Bill not found');
  if (head.status !== 'PAID') throw new BusinessRuleError('Only a paid bill can have items returned');
  // A refund changes today's cash and sales: a closed day is final (reopen it first)
  await assertBusinessDayOpen(db, head.branchId);

  const created = await db.transaction(async (tx) => {
    // Serialise returns of the same bill so two clerks cannot both return the last bottle
    const [bill] = await tx.select().from(bills).where(eq(bills.id, billId)).for('update');
    if (!bill || bill.status !== 'PAID') throw new BusinessRuleError('Only a paid bill can have items returned');
    const items = await tx.select({ item: billItems, name: products.name, trackStock: products.trackStock })
      .from(billItems).innerJoin(products, eq(products.id, billItems.productId)).where(eq(billItems.billId, billId));
    const before = await returnedByItem(tx as unknown as typeof db, items.map((i) => i.item.id));

    let plan;
    try {
      plan = planSalesReturn({ subtotal: bill.subtotal, discount: bill.discount }, items.map(({ item, name }) => {
        const r = before.get(item.id);
        return {
          billItemId: item.id, productId: item.productId, name, quantity: item.quantity, lineTotal: item.lineTotal, taxAmount: item.taxAmount,
          servingId: item.servingId, returnedQty: r?.qty ?? 0, returnedGross: r?.gross ?? '0', returnedTax: r?.tax ?? '0',
        };
      }), input.items);
    } catch (err) { throw new BusinessRuleError((err as Error).message); }

    const refundMode = (bill.paymentMode ?? 'CASH') as 'CASH' | 'CARD' | 'UPI' | 'CREDIT';
    const [ret] = await tx.insert(salesReturns).values({
      returnNumber: number('RET'), branchId: bill.branchId, billId, reason: input.reason, refundMode,
      grossAmount: plan.totals.gross, taxAmount: plan.totals.tax, discountAmount: plan.totals.discount, refundAmount: plan.totals.refund, createdById: user.sub,
    }).returning();
    await tx.insert(salesReturnItems).values(plan.lines.map((l) => ({
      returnId: ret.id, billItemId: l.billItemId, productId: l.productId, quantity: l.quantity, grossAmount: l.gross, taxAmount: l.tax,
    })));

    // The bottles go back to the counter they were sold from (only where stock is tracked)
    const trackedIds = new Set(items.filter((i) => i.trackStock).map((i) => i.item.productId));
    const back = plan.lines.filter((l) => trackedIds.has(l.productId));
    if (back.length > 0) {
      await addStockDeltas(tx, back.map((l) => ({ branchId: bill.branchId, productId: l.productId, quantity: l.quantity })));
      if (bill.saleTypeId) await addStockDeltas(tx, back.map((l) => ({ branchId: bill.branchId, productId: l.productId, saleTypeId: bill.saleTypeId!, quantity: l.quantity })));
      await tx.insert(stockAudit).values(back.map((l) => ({
        branchId: bill.branchId, productId: l.productId, userId: user.sub, changeQty: l.quantity, reason: 'SALES_RETURN' as const, referenceId: ret.id, saleTypeId: bill.saleTypeId,
      })));
    }

    // A khata sale is refunded by reducing what the customer owes
    if (refundMode === 'CREDIT' && bill.customerId) {
      const [customer] = await tx.select().from(customers).where(eq(customers.id, bill.customerId)).for('update');
      if (customer) {
        const balanceAfter = applyCreditReversal(customer.currentCredit, plan.totals.refund);
        await tx.update(customers).set({ currentCredit: balanceAfter }).where(eq(customers.id, customer.id));
        await tx.insert(creditTransactions).values({
          customerId: customer.id, type: 'ADJUSTMENT', amount: plan.totals.refund, balanceAfter, billId: bill.id, recordedById: user.sub,
          notes: `Return ${ret.returnNumber} of bill ${bill.billNumber}`,
        });
      }
    }

    await emitDomainEvent('salesReturn.recorded', { ret, bill, totals: plan.totals }, tx);
    return ret;
  });
  await logAudit(user.sub, 'bill.return', { type: 'bill', id: billId }, { returnNumber: created.returnNumber, refund: created.refundAmount, reason: input.reason });
  return getSalesReturn(created.id);
}

export async function getSalesReturn(id: string) {
  const [ret] = await db.select().from(salesReturns).where(eq(salesReturns.id, id)).limit(1);
  if (!ret) throw new NotFoundError('Return not found');
  const items = await db.select({
    billItemId: salesReturnItems.billItemId, productId: salesReturnItems.productId, quantity: salesReturnItems.quantity,
    gross: salesReturnItems.grossAmount, tax: salesReturnItems.taxAmount, name: products.name,
  }).from(salesReturnItems).innerJoin(products, eq(products.id, salesReturnItems.productId)).where(eq(salesReturnItems.returnId, id));
  return { ...ret, items };
}

/** Returns made against a bill, and how many of each line have come back (for the return dialog). */
export async function listBillReturns(billId: string) {
  const rets = await db.select().from(salesReturns).where(eq(salesReturns.billId, billId)).orderBy(desc(salesReturns.createdAt));
  const full = await Promise.all(rets.map((r) => getSalesReturn(r.id)));
  const lineIds = (await db.select({ id: billItems.id }).from(billItems).where(eq(billItems.billId, billId))).map((r) => r.id);
  const returned = await returnedByItem(db, lineIds);
  return { returns: full, returnedByItem: Object.fromEntries([...returned].map(([k, v]) => [k, v.qty])) };
}

// ─── RETURN TO A SUPPLIER (debit note) ───────────────────────────────────────────

export const PurchaseReturnSchema = z.object({
  branchId: z.string().uuid(),
  supplierName: z.string().trim().min(2).max(120),
  invoiceId: z.string().uuid().optional(),
  reason: z.string().trim().min(5, 'Say why the bottles are going back').max(300),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(100_000),
    unitCost: z.string().regex(/^\d{1,8}(\.\d{1,6})?$/).optional(),   // defaults to what this outlet last paid
  })).min(1).max(200)
    .refine((l) => new Set(l.map((x) => x.productId)).size === l.length, 'A product appears twice'),
});

export async function createPurchaseReturn(input: z.infer<typeof PurchaseReturnSchema>, user: JwtPayload) {
  const created = await db.transaction(async (tx) => {
    const [branch] = await tx.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, input.branchId)).limit(1);
    if (!branch) throw new NotFoundError('Branch not found');
    const ids = input.items.map((i) => i.productId);
    const prods = await tx.select({ id: products.id, name: products.name, syndicateId: products.syndicateId, costPrice: products.costPrice }).from(products).where(inArray(products.id, ids));
    const bad = ids.filter((id) => { const p = prods.find((x) => x.id === id); return !p || (p.syndicateId && p.syndicateId !== branch.syndicateId); });
    if (bad.length > 0) throw new BusinessRuleError(`One or more products not found: ${bad.join(', ')}`);
    const costs = await tx.select({ productId: branchProductCosts.productId, cost: branchProductCosts.costPrice }).from(branchProductCosts)
      .where(and(eq(branchProductCosts.branchId, input.branchId), inArray(branchProductCosts.productId, ids)));
    const branchCost = new Map(costs.map((c) => [c.productId, c.cost]));

    let priced;
    try {
      priced = purchaseReturnTotal(input.items.map((i) => {
        const p = prods.find((x) => x.id === i.productId)!;
        const unitCost = i.unitCost ?? branchCost.get(i.productId) ?? p.costPrice ?? '0';
        if (new Decimal(unitCost).lte(0)) throw new Error(`${p.name}: no cost on record, enter the cost price`);
        return { productId: i.productId, quantity: i.quantity, unitCost };
      }));
    } catch (err) { throw new BusinessRuleError((err as Error).message); }

    for (const line of priced.lines) {
      // out of the default counter only, like breakage: the other sale types' counters keep their bottles
      const [updated] = await tx.update(stock)
        .set({ quantity: sql`${stock.quantity} - ${line.quantity}` })
        .where(and(
          eq(stock.branchId, input.branchId), eq(stock.productId, line.productId),
          sql`${stock.quantity} - ${line.quantity} >= coalesce((SELECT sum(sbt.quantity) FROM stock_by_type sbt WHERE sbt.branch_id = ${stock.branchId} AND sbt.product_id = ${stock.productId}), 0)`,
        )).returning({ quantity: stock.quantity });
      if (!updated) {
        const name = prods.find((p) => p.id === line.productId)!.name;
        throw new BusinessRuleError(`Insufficient stock for ${name}: returning ${line.quantity} but the default counter holds fewer`);
      }
    }

    const [ret] = await tx.insert(purchaseReturns).values({
      returnNumber: number('PRT'), branchId: input.branchId, supplierName: input.supplierName.replace(/\s+/g, ' '), invoiceId: input.invoiceId ?? null,
      reason: input.reason, amount: priced.total, createdById: user.sub,
    }).returning();
    await tx.insert(purchaseReturnItems).values(priced.lines.map((l) => ({ returnId: ret.id, productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, amount: l.amount })));
    await tx.insert(stockAudit).values(priced.lines.map((l) => ({
      branchId: input.branchId, productId: l.productId, userId: user.sub, changeQty: -l.quantity, reason: 'PURCHASE_RETURN' as const, referenceId: ret.id,
    })));
    await emitDomainEvent('purchaseReturn.recorded', { ret }, tx);
    return ret;
  });
  await logAudit(user.sub, 'purchase.return', { type: 'purchase_return', id: created.id }, { returnNumber: created.returnNumber, supplier: created.supplierName, amount: created.amount });
  return getPurchaseReturn(created.id);
}

export async function getPurchaseReturn(id: string) {
  const [ret] = await db.select().from(purchaseReturns).where(eq(purchaseReturns.id, id)).limit(1);
  if (!ret) throw new NotFoundError('Return not found');
  const items = await db.select({ productId: purchaseReturnItems.productId, quantity: purchaseReturnItems.quantity, unitCost: purchaseReturnItems.unitCost, amount: purchaseReturnItems.amount, name: products.name })
    .from(purchaseReturnItems).innerJoin(products, eq(products.id, purchaseReturnItems.productId)).where(eq(purchaseReturnItems.returnId, id));
  return { ...ret, items };
}

export async function listPurchaseReturns(branchId: string) {
  const rets = await db.select().from(purchaseReturns).where(eq(purchaseReturns.branchId, branchId)).orderBy(desc(purchaseReturns.createdAt)).limit(100);
  return { returns: await Promise.all(rets.map((r) => getPurchaseReturn(r.id))) };
}
