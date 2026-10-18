import { z } from 'zod';
import { db } from '../../db/client.js';
import { bills, billItems, stock, stockAudit, branches } from '../../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { calculateBill, assertMrpMatch } from './billing.engine.js';
import { checkStockAvailability, computeStockDeltas, computeVoidStockDeltas } from '../stock/stock.engine.js';
import { getProductById } from '../products/product.service.js';
import type { JwtPayload } from '../auth/auth.service.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const CreateBillSchema = z.object({
  branchId:    z.string().uuid(),
  paymentMode: z.enum(['CASH', 'CARD', 'UPI']),
  discount:    z.string().regex(/^\d+(\.\d{1,2})?$/).optional().default('0'),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity:  z.number().int().positive(),
  })).min(1),
});

export const VoidBillSchema = z.object({
  voidReason: z.string().min(5),
});

export type CreateBillInput = z.infer<typeof CreateBillSchema>;

// ─── BILL NUMBER GENERATOR ───────────────────────────────────────────────────

async function generateBillNumber(branchId: string, tx: any): Promise<string> {
  // Count existing bills in this branch this year
  const [branch] = await tx
    .select({ code: branches.code })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);

  const code = branch?.code ?? 'XX';
  const year = new Date().getFullYear();
  // Get count of today's bills for sequence
  const existing = await tx
    .select()
    .from(bills)
    .where(eq(bills.branchId, branchId));

  const seq = String(existing.length + 1).padStart(6, '0');
  return `${code}-${year}-${seq}`;
}

// ─── BILLING SERVICE ─────────────────────────────────────────────────────────

export async function createBill(input: CreateBillInput, cashier: JwtPayload) {
  // 1. Load products and validate MRP
  const productIds = input.items.map((i) => i.productId);
  const productList = await Promise.all(productIds.map((id) => getProductById(id)));

  const productMap = new Map(productList.filter(Boolean).map((p) => [p!.id, p!]));

  if (productMap.size !== productIds.length) {
    throw new Error('One or more products not found');
  }

  // 2. Build billing engine input (use registered MRP)
  const lineInputs = input.items.map((item) => {
    const product = productMap.get(item.productId)!;
    // MRP is enforced from the database — no override at POS
    return {
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: product.mrp,
      taxRate: '18.00',   // TODO: load from category in Phase 2
    };
  });

  // 3. Calculate totals
  const calculation = calculateBill(lineInputs, input.discount);

  // 4. Check stock availability
  const stockEntries = await db
    .select()
    .from(stock)
    .where(
      and(
        eq(stock.branchId, input.branchId),
        inArray(stock.productId, productIds),
      ),
    );

  const stockMap = new Map(stockEntries.map((s) => [s.productId, s.quantity]));
  const shortages = checkStockAvailability(
    input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    stockMap,
  );

  if (shortages.length > 0) {
    throw new Error(
      `Insufficient stock: ${shortages
        .map((s) => `product ${s.productId} (requested ${s.requested}, available ${s.available})`)
        .join(', ')}`,
    );
  }

  // 5. Transact: insert bill + items + deduct stock + audit
  const createdBill = await db.transaction(async (tx) => {
    const billNumber = await generateBillNumber(input.branchId, tx);
    const now = new Date();

    const [bill] = await tx.insert(bills).values({
      branchId:    input.branchId,
      cashierId:   cashier.sub,
      billNumber,
      status:      'PAID',
      subtotal:    calculation.subtotal,
      taxAmount:   calculation.taxAmount,
      discount:    calculation.discount,
      total:       calculation.total,
      paymentMode: input.paymentMode,
      paidAt:      now,
    }).returning();

    await tx.insert(billItems).values(
      calculation.lines.map((line) => ({
        billId:    bill.id,
        productId: line.productId,
        quantity:  line.quantity,
        unitPrice: line.unitPrice,
        taxRate:   line.taxRate,
        taxAmount: line.taxAmount,
        lineTotal: line.lineTotal,
      })),
    );

    // Deduct stock
    const deltas = computeStockDeltas(
      input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );

    for (const delta of deltas) {
      await tx
        .update(stock)
        .set({ quantity: stockEntries.find((s) => s.productId === delta.productId)!.quantity + delta.delta })
        .where(
          and(
            eq(stock.branchId, input.branchId),
            eq(stock.productId, delta.productId),
          ),
        );
    }

    // Audit log
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

    return bill;
  });

  return createdBill;
}

// ─── VOID BILL ───────────────────────────────────────────────────────────────

export async function voidBill(
  billId: string,
  voidReason: string,
  user: JwtPayload,
) {
  const [bill] = await db
    .select()
    .from(bills)
    .where(eq(bills.id, billId))
    .limit(1);

  if (!bill) throw new Error('Bill not found');
  if (bill.status === 'VOIDED') throw new Error('Bill is already voided');

  const items = await db
    .select()
    .from(billItems)
    .where(eq(billItems.billId, billId));

  const stockEntries = await db
    .select()
    .from(stock)
    .where(
      and(
        eq(stock.branchId, bill.branchId),
        inArray(stock.productId, items.map((i) => i.productId)),
      ),
    );

  const stockMap = new Map(stockEntries.map((s) => [s.productId, s]));

  await db.transaction(async (tx) => {
    await tx
      .update(bills)
      .set({ status: 'VOIDED', voidedAt: new Date(), voidReason })
      .where(eq(bills.id, billId));

    // Reverse stock
    const deltas = computeVoidStockDeltas(
      items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );

    for (const delta of deltas) {
      const current = stockMap.get(delta.productId);
      if (!current) continue;
      await tx
        .update(stock)
        .set({ quantity: current.quantity + delta.delta })
        .where(
          and(
            eq(stock.branchId, bill.branchId),
            eq(stock.productId, delta.productId),
          ),
        );
    }

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
  });
}

// ─── BILL LOOKUP ─────────────────────────────────────────────────────────────

export async function getBillById(billId: string) {
  const [bill] = await db
    .select()
    .from(bills)
    .where(eq(bills.id, billId))
    .limit(1);

  if (!bill) return null;

  const items = await db
    .select()
    .from(billItems)
    .where(eq(billItems.billId, billId));

  return { ...bill, items };
}
