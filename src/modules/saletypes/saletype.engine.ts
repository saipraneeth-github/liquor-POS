/**
 * saletype.engine.ts — PURE rules for sale types (Walk-in, Janata, ...).
 *
 * A sale type is a price list plus its own counter:
 *   - the DEFAULT type (Walk-in) is priced by products.mrp and its stock is whatever is left of the shop's total
 *     stock after the explicit counters of the other types;
 *   - every other type has its own price per product (no price = not sold under that type) and an explicit counter.
 * Rows that reference a sale type store NULL for the default type, so all data recorded before sale types existed is
 * default-type data and nothing had to be migrated.
 */
import { Decimal } from 'decimal.js';

export const DEFAULT_SALE_TYPES = [
  { code: 'WALK_IN', name: 'Walk-in', sortOrder: 0, isDefault: true },
  { code: 'JANATA', name: 'Janata', sortOrder: 1, isDefault: false },
] as const;

export interface SaleTypeLite { id: string; name: string; isDefault: boolean }

/** What goes in a sale_type_id column: NULL for the default type. */
export function rowTypeId(type: Pick<SaleTypeLite, 'id' | 'isDefault'>): string | null {
  return type.isDefault ? null : type.id;
}

/** 'Permit Room' → 'PERMIT_ROOM'. */
export function normalizeSaleTypeCode(raw: string): string {
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!code) throw new Error(`Cannot derive a sale type code from "${raw}"`);
  return code.slice(0, 40);
}

/** Tax-inclusive unit price of a product under a sale type. Non-default types (Janata, ...) default to Walk-in price (MRP). */
export function unitPriceFor(type: Pick<SaleTypeLite, 'isDefault'>, mrp: string, typePrice: string | null | undefined): string | null {
  if (type.isDefault) return mrp;
  if (typePrice === null || typePrice === undefined || (typeof typePrice === 'string' && typePrice.trim() === '')) return mrp;
  const p = new Decimal(typePrice);
  return p.gt(0) ? p.toFixed(2) : mrp;
}

/**
 * Bottles available to one counter of a product.
 *   default type  → total − Σ explicit counters
 *   other type    → its own explicit counter
 */
export function counterQuantity(type: Pick<SaleTypeLite, 'id' | 'isDefault'>, total: number, explicit: Map<string, number>): number {
  if (!type.isDefault) return explicit.get(type.id) ?? 0;
  let sum = 0;
  for (const q of explicit.values()) sum += q;
  return total - sum;
}

/** Σ of the explicit (non-default) counters. */
export function explicitTotal(explicit: Map<string, number>): number {
  let sum = 0;
  for (const q of explicit.values()) sum += q;
  return sum;
}

/** Moves between two counters: returns the new explicit counters, or throws a readable message. */
export function applyTransfer(
  total: number,
  explicit: Map<string, number>,
  from: SaleTypeLite,
  to: SaleTypeLite,
  quantity: number,
): Map<string, number> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive whole number');
  if (from.id === to.id) throw new Error('Choose two different sale types');
  const available = counterQuantity(from, total, explicit);
  if (available < quantity) throw new Error(`Only ${Math.max(0, available)} available in ${from.name}`);
  const next = new Map(explicit);
  if (!from.isDefault) next.set(from.id, (next.get(from.id) ?? 0) - quantity);
  if (!to.isDefault) next.set(to.id, (next.get(to.id) ?? 0) + quantity);
  return next;
}
