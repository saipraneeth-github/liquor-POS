/**
 * print.service.ts — Loads a bill / KOT, shapes it for the print generator and renders it.
 * Output formats: html (browser print), text, escpos (raw bytes), json (the print model).
 */

import { Decimal } from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { billItems, bills, branches, customers, kotItems, kotOrders, products, tableSessions, tables, users } from '../../db/schema.js';
import {
  buildBillRows,
  buildKotRows,
  renderEscPos,
  renderHtml,
  renderText,
  sendToPrinter,
  widthChars,
  type PrintBill,
  type PrintKot,
} from '../../lib/print/index.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { formatBusinessDateTime } from '../../lib/business-day.js';

export const PRINT_FORMATS = ['html', 'text', 'escpos', 'json'] as const;
export type PrintFormat = (typeof PRINT_FORMATS)[number];

export interface RenderedDoc {
  contentType: string;
  body: string | Buffer | object;
}

// ─── MODEL LOADERS ──────────────────────────────────────────────────────────

/** Buyer in another state (first two GSTIN digits differ from the branch's) = inter-state supply -> IGST. */
export function isInterState(branchGstin: string | null | undefined, buyerGstin: string | null | undefined): boolean {
  if (!branchGstin || !buyerGstin) return false;
  return branchGstin.slice(0, 2) !== buyerGstin.slice(0, 2);
}

export async function loadBillPrintModel(billId: string, interStateOverride?: boolean) {
  const [bill] = await db.select().from(bills).where(eq(bills.id, billId)).limit(1);
  if (!bill) throw new NotFoundError('Bill not found');

  const [branch] = await db.select().from(branches).where(eq(branches.id, bill.branchId)).limit(1);
  const [cashier] = await db.select({ name: users.name }).from(users).where(eq(users.id, bill.cashierId)).limit(1);
  const [customer] = bill.customerId
    ? await db.select({ name: customers.name }).from(customers).where(eq(customers.id, bill.customerId)).limit(1)
    : [];
  const items = await db
    .select({ item: billItems, productName: products.name, hsn: products.hsnCode })
    .from(billItems)
    .innerJoin(products, eq(billItems.productId, products.id))
    .where(eq(billItems.billId, billId));

  const model: PrintBill = {
    branchName: branch.name,
    branchAddress: branch.address ?? '',
    gstin: branch.gstin ?? undefined,
    billNumber: bill.billNumber,
    date: formatBusinessDateTime(bill.paidAt ?? bill.createdAt ?? new Date()),
    cashierName: cashier?.name ?? '-',
    customerName: customer?.name,
    buyerGstin: bill.customerGstin ?? undefined,
    roundOff: Number(bill.roundOff),
    items: items.map(({ item, productName, hsn }) => ({
      hsn: hsn ?? undefined,
      name: item.servingLabel ? `${productName} (${item.servingLabel})` : productName,
      qty: item.quantity,
      rate: Number(item.unitPrice),
      net: Number(item.lineTotal),
      taxRate: Number(item.taxRate),
      taxAmount: Number(item.taxAmount),
    })),
    subtotal: Number(bill.subtotal),
    discount: Number(bill.discount),
    taxAmount: Number(bill.taxAmount),
    total: Number(bill.total),
    paymentMode: bill.paymentMode ?? '-',
    voided: bill.status === 'VOIDED',
    interState: interStateOverride ?? isInterState(branch.gstin, bill.customerGstin),
    paperWidth: branch.paperWidth === '80mm' ? '80mm' : '58mm',
  };
  return { model, branch, billBranchId: bill.branchId, cashDrawer: bill.paymentMode === 'CASH' };
}

export async function loadKotPrintModel(kotOrderId: string) {
  const [order] = await db.select().from(kotOrders).where(eq(kotOrders.id, kotOrderId)).limit(1);
  if (!order) throw new NotFoundError('KOT not found');

  const [branch] = await db.select().from(branches).where(eq(branches.id, order.branchId)).limit(1);
  const [session] = await db.select().from(tableSessions).where(eq(tableSessions.id, order.tableSessionId)).limit(1);
  const [table] = session ? await db.select({ name: tables.name }).from(tables).where(eq(tables.id, session.tableId)).limit(1) : [];
  const [steward] = await db.select({ name: users.name }).from(users).where(eq(users.id, order.createdById)).limit(1);
  const items = await db
    .select({ item: kotItems, productName: products.name })
    .from(kotItems)
    .innerJoin(products, eq(kotItems.productId, products.id))
    .where(eq(kotItems.kotOrderId, kotOrderId));

  const model: PrintKot = {
    branchName: branch.name,
    kotNumber: order.id.slice(0, 8).toUpperCase(),
    tableName: table?.name ?? '-',
    destination: order.destination,
    steward: steward?.name ?? '-',
    date: formatBusinessDateTime(order.createdAt ?? new Date()),
    notes: order.notes ?? undefined,
    items: items
      .filter(({ item }) => item.status !== 'CANCELLED')
      .map(({ item, productName }) => ({
        name: item.servingLabel ? `${productName} (${item.servingLabel})` : productName,
        qty: item.quantity,
        notes: item.notes ?? undefined,
      })),
    paperWidth: branch.paperWidth === '80mm' ? '80mm' : '58mm',
  };
  return { model, branch, branchId: order.branchId };
}

// ─── RENDERING ──────────────────────────────────────────────────────────────

export function renderBill(model: PrintBill, format: PrintFormat, cashDrawer = false): RenderedDoc {
  const rows = buildBillRows(model);
  const width = widthChars(model.paperWidth);
  switch (format) {
    case 'json': return { contentType: 'application/json', body: model };
    case 'text': return { contentType: 'text/plain; charset=utf-8', body: renderText(rows, width) };
    case 'escpos': return { contentType: 'application/octet-stream', body: Buffer.from(renderEscPos(rows, width, { kickDrawer: cashDrawer })) };
    case 'html': return { contentType: 'text/html; charset=utf-8', body: renderHtml(rows, width, `Bill ${model.billNumber}`) };
  }
}

export function renderKot(model: PrintKot, format: PrintFormat): RenderedDoc {
  const rows = buildKotRows(model);
  const width = widthChars(model.paperWidth);
  switch (format) {
    case 'json': return { contentType: 'application/json', body: model };
    case 'text': return { contentType: 'text/plain; charset=utf-8', body: renderText(rows, width) };
    case 'escpos': return { contentType: 'application/octet-stream', body: Buffer.from(renderEscPos(rows, width)) };
    case 'html': return { contentType: 'text/html; charset=utf-8', body: renderHtml(rows, width, `KOT ${model.kotNumber}`) };
  }
}

// ─── SENDING ────────────────────────────────────────────────────────────────

export async function sendToBranchPrinter(
  branch: { printerHost: string | null; printerPort: number },
  data: Uint8Array,
): Promise<void> {
  if (!branch.printerHost) {
    throw new BusinessRuleError('No network printer is configured for this branch. Use browser print instead.');
  }
  try {
    await sendToPrinter(branch.printerHost, branch.printerPort, data);
  } catch (err) {
    throw new BusinessRuleError((err as Error).message);
  }
}

export const toMoney = (n: Decimal.Value) => new Decimal(n).toFixed(2);
