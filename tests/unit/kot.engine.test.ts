/**
 * Phase 3 — KOT Engine Tests (TDD — written BEFORE implementation)
 * Tests cover: KOT item status flow, consolidated bill total, multi-KOT merging
 */

import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  canTransitionKotItem,
  consolidateKotOrders,
  KotItemStatus,
  type KotItem,
  type KotOrder,
} from '../../src/modules/kot/kot.engine';

describe('kot.engine — item status transitions', () => {
  it('PENDING → PREPARING is valid', () => {
    expect(canTransitionKotItem('PENDING', 'PREPARING')).toBe(true);
  });

  it('PREPARING → SERVED is valid', () => {
    expect(canTransitionKotItem('PREPARING', 'SERVED')).toBe(true);
  });

  it('PENDING → CANCELLED is valid', () => {
    expect(canTransitionKotItem('PENDING', 'CANCELLED')).toBe(true);
  });

  it('SERVED → PENDING is invalid (cannot revert served item)', () => {
    expect(canTransitionKotItem('SERVED', 'PENDING')).toBe(false);
  });

  it('CANCELLED → PREPARING is invalid', () => {
    expect(canTransitionKotItem('CANCELLED', 'PREPARING')).toBe(false);
  });

  it('SERVED → CANCELLED is invalid', () => {
    expect(canTransitionKotItem('SERVED', 'CANCELLED')).toBe(false);
  });
});

describe('kot.engine — consolidateKotOrders', () => {
  const makeItem = (productId: string, qty: number, mrp: string, status: KotItemStatus = 'SERVED'): KotItem => ({
    id: `item-${productId}-${Math.random()}`,
    kotOrderId: 'order-1',
    productId,
    quantity: qty,
    unitPrice: new Decimal(mrp),
    taxRate: new Decimal('18.00'),
    status,
    notes: null,
  });

  it('consolidates items from multiple KOT orders into a single bill summary', () => {
    const orders: KotOrder[] = [
      {
        id: 'kot-1',
        tableSessionId: 'session-1',
        status: 'SERVED',
        items: [makeItem('prod-A', 2, '200.00'), makeItem('prod-B', 1, '500.00')],
      },
      {
        id: 'kot-2',
        tableSessionId: 'session-1',
        status: 'SERVED',
        items: [makeItem('prod-A', 1, '200.00')],
      },
    ];

    const result = consolidateKotOrders(orders);
    // prod-A: 3 units × 200 = 600; prod-B: 1 × 500 = 500; total = 1100
    expect(result.grandTotal.toFixed(2)).toBe('1100.00');
    expect(result.lineItems).toHaveLength(2);
    const lineA = result.lineItems.find(l => l.productId === 'prod-A')!;
    expect(lineA.quantity).toBe(3);
    expect(lineA.lineTotal.toFixed(2)).toBe('600.00');
  });

  it('excludes CANCELLED items from consolidation', () => {
    const orders: KotOrder[] = [
      {
        id: 'kot-3',
        tableSessionId: 'session-2',
        status: 'SERVED',
        items: [
          makeItem('prod-C', 2, '300.00', 'SERVED'),
          makeItem('prod-D', 1, '100.00', 'CANCELLED'),
        ],
      },
    ];

    const result = consolidateKotOrders(orders);
    expect(result.grandTotal.toFixed(2)).toBe('600.00');
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].productId).toBe('prod-C');
  });

  it('returns zero totals for empty orders', () => {
    const result = consolidateKotOrders([]);
    expect(result.grandTotal.toFixed(2)).toBe('0.00');
    expect(result.lineItems).toHaveLength(0);
  });

  it('tax is computed correctly (GST-inclusive, 18%)', () => {
    const orders: KotOrder[] = [
      {
        id: 'kot-4',
        tableSessionId: 'session-3',
        status: 'SERVED',
        items: [makeItem('prod-E', 1, '118.00')], // MRP ₹118 inclusive of 18% GST
      },
    ];

    const result = consolidateKotOrders(orders);
    // taxable = 118 / 1.18 = 100; tax = 18
    expect(result.totalTax.toFixed(2)).toBe('18.00');
    expect(result.totalTaxable.toFixed(2)).toBe('100.00');
  });
});
