/**
 * kot.engine.ts — Pure KOT logic: status transitions and order consolidation.
 * No DB calls. All side-effects in kot.service.ts.
 */

import { Decimal } from 'decimal.js';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type KotItemStatus = 'PENDING' | 'PREPARING' | 'SERVED' | 'CANCELLED';
export type KotStatus     = 'PENDING' | 'PREPARING' | 'SERVED' | 'CANCELLED';

export interface KotItem {
  id: string;
  kotOrderId: string;
  productId: string;
  quantity: number;
  unitPrice: Decimal;      // MRP at order time
  taxRate: Decimal;        // e.g., 18.00
  status: KotItemStatus;
  notes: string | null;
}

export interface KotOrder {
  id: string;
  tableSessionId: string;
  status: KotStatus;
  items: KotItem[];
}

export interface ConsolidatedLineItem {
  productId: string;
  quantity: number;
  unitPrice: Decimal;
  taxRate: Decimal;
  lineTotal: Decimal;
  taxableValue: Decimal;
  taxAmount: Decimal;
}

export interface ConsolidatedBillSummary {
  lineItems: ConsolidatedLineItem[];
  grandTotal: Decimal;
  totalTaxable: Decimal;
  totalTax: Decimal;
}

// ─── STATUS TRANSITION RULES ──────────────────────────────────────────────────

/**
 * One-way flow: PENDING → PREPARING → SERVED
 * PENDING or PREPARING may be CANCELLED.
 * Terminal states (SERVED, CANCELLED) cannot transition further.
 */
const ALLOWED_TRANSITIONS: Record<KotItemStatus, KotItemStatus[]> = {
  PENDING:    ['PREPARING', 'CANCELLED'],
  PREPARING:  ['SERVED', 'CANCELLED'],
  SERVED:     [],
  CANCELLED:  [],
};

export function canTransitionKotItem(from: KotItemStatus, to: KotItemStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ─── CONSOLIDATION ────────────────────────────────────────────────────────────

/**
 * Merges all non-CANCELLED KOT items from multiple KOT orders belonging to the
 * same table session into a single bill summary.
 *
 * - Items with identical productId are summed.
 * - Tax is computed GST-inclusive per line: taxable = lineTotal / (1 + taxRate/100)
 */
export function consolidateKotOrders(orders: KotOrder[]): ConsolidatedBillSummary {
  // Map productId → aggregated line
  const lineMap = new Map<string, ConsolidatedLineItem>();

  for (const order of orders) {
    for (const item of order.items) {
      if (item.status === 'CANCELLED') continue;

      const lineTotal = item.unitPrice.times(item.quantity);
      const divisor   = new Decimal(1).plus(item.taxRate.div(100));
      const taxable   = lineTotal.div(divisor).toDecimalPlaces(2);
      const tax       = lineTotal.minus(taxable);

      const existing = lineMap.get(item.productId);
      if (existing) {
        lineMap.set(item.productId, {
          ...existing,
          quantity:     existing.quantity + item.quantity,
          lineTotal:    existing.lineTotal.plus(lineTotal),
          taxableValue: existing.taxableValue.plus(taxable),
          taxAmount:    existing.taxAmount.plus(tax),
        });
      } else {
        lineMap.set(item.productId, {
          productId:    item.productId,
          quantity:     item.quantity,
          unitPrice:    item.unitPrice,
          taxRate:      item.taxRate,
          lineTotal,
          taxableValue: taxable,
          taxAmount:    tax,
        });
      }
    }
  }

  const lineItems    = Array.from(lineMap.values());
  const grandTotal   = lineItems.reduce((s, l) => s.plus(l.lineTotal),    new Decimal(0));
  const totalTaxable = lineItems.reduce((s, l) => s.plus(l.taxableValue), new Decimal(0));
  const totalTax     = lineItems.reduce((s, l) => s.plus(l.taxAmount),    new Decimal(0));

  return { lineItems, grandTotal, totalTaxable, totalTax };
}
