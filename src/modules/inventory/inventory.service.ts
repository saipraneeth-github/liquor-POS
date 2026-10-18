import { db } from '../../db/client.js';
import {
  products,
  stock,
  stockAudit,
  supplierInvoices,
  supplierInvoiceItems,
  billItems,
  bills,
} from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import {
  parseAndValidateInvoice,
  type RawExtractedInvoice,
} from './invoice-parser.engine.js';
import { estimateIndent, type IndentEstimationResult } from '../stock/indent.engine.js';
import type { JwtPayload } from '../auth/auth.service.js';

export async function parseInvoice(rawInvoice: RawExtractedInvoice) {
  // Load current product catalog references
  const allProducts = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      name: products.name,
      volumeMl: products.volumeMl,
      currentMrp: products.mrp,
    })
    .from(products);

  return parseAndValidateInvoice(rawInvoice, allProducts);
}

export interface ApproveInvoiceInput {
  branchId: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate?: string;
  totalAmount: string;
  notes?: string;
  items: Array<{
    productId: string;
    rawDescription: string;
    quantity: number;
    costPrice: string;
    mrp: string;
    taxRate?: string;
  }>;
}

export async function approveInwardInvoice(input: ApproveInvoiceInput, user: JwtPayload) {
  return await db.transaction(async (tx) => {
    // 1. Create supplier invoice record
    const [invoice] = await tx
      .insert(supplierInvoices)
      .values({
        branchId: input.branchId,
        createdById: user.sub,
        approvedById: user.sub,
        supplierName: input.supplierName,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : new Date(),
        totalAmount: input.totalAmount,
        status: 'APPROVED',
        notes: input.notes,
        approvedAt: new Date(),
      })
      .returning();

    for (const item of input.items) {
      const lineCost = (Number(item.costPrice) * item.quantity).toFixed(2);

      // Insert line item
      await tx.insert(supplierInvoiceItems).values({
        invoiceId: invoice.id,
        productId: item.productId,
        rawDescription: item.rawDescription,
        quantity: item.quantity,
        costPrice: item.costPrice,
        mrp: item.mrp,
        taxRate: item.taxRate ?? '18.00',
        lineCostTotal: lineCost,
      });

      // Update or create stock entry
      const [existingStock] = await tx
        .select()
        .from(stock)
        .where(and(eq(stock.branchId, input.branchId), eq(stock.productId, item.productId)))
        .limit(1);

      if (existingStock) {
        await tx
          .update(stock)
          .set({ quantity: existingStock.quantity + item.quantity })
          .where(and(eq(stock.branchId, input.branchId), eq(stock.productId, item.productId)));
      } else {
        await tx.insert(stock).values({
          branchId: input.branchId,
          productId: item.productId,
          quantity: item.quantity,
          reorderLevel: 5,
        });
      }

      // Record audit log
      await tx.insert(stockAudit).values({
        branchId: input.branchId,
        productId: item.productId,
        userId: user.sub,
        changeQty: item.quantity,
        reason: 'PURCHASE',
        referenceId: invoice.id,
      });

      // Update product cost price and MRP if changed
      await tx
        .update(products)
        .set({ costPrice: item.costPrice, mrp: item.mrp })
        .where(eq(products.id, item.productId));
    }

    return invoice;
  });
}

export async function getStockStatus(branchId: string) {
  return db
    .select({
      stockId: stock.id,
      productId: products.id,
      name: products.name,
      brand: products.brand,
      volumeMl: products.volumeMl,
      mrp: products.mrp,
      quantity: stock.quantity,
      reorderLevel: stock.reorderLevel,
    })
    .from(stock)
    .innerJoin(products, eq(stock.productId, products.id))
    .where(eq(stock.branchId, branchId));
}

export async function getBranchIndentEstimations(
  branchId: string,
  periodDays = 30,
  leadTimeDays = 5,
  bufferDays = 3,
): Promise<IndentEstimationResult[]> {
  const stockList = await getStockStatus(branchId);

  // For each product, calculate total sold in the past `periodDays`
  // In our schema, billItems joined with bills where branchId = branchId and bills.status = 'PAID'
  const estimations: IndentEstimationResult[] = [];

  for (const item of stockList) {
    // Count units sold
    const [salesRow] = await db
      .select({
        totalSold: sql<number>`coalesce(sum(${billItems.quantity}), 0)::int`,
      })
      .from(billItems)
      .innerJoin(bills, eq(billItems.billId, bills.id))
      .where(
        and(
          eq(bills.branchId, branchId),
          eq(bills.status, 'PAID'),
          eq(billItems.productId, item.productId),
        ),
      );

    const totalSold = Number(salesRow?.totalSold ?? 0);

    const estimation = estimateIndent({
      productId: item.productId,
      productName: `${item.brand} - ${item.name} (${item.volumeMl ?? 750}ml)`,
      currentStock: item.quantity,
      totalSoldInPeriod: totalSold,
      periodDays,
      leadTimeDays,
      bufferDays,
    });

    estimations.push(estimation);
  }

  return estimations;
}
