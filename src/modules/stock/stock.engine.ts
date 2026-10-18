/**
 * Stock deduction logic — pure, testable functions.
 * DB operations are in billing.service.ts; this module owns the rules.
 */

export interface StockEntry {
  productId: string;
  quantity: number;
  available: number;
}

export interface StockShortage {
  productId: string;
  requested: number;
  available: number;
}

/**
 * Validates that sufficient stock exists for all bill line items.
 * Returns a list of shortages (empty = all OK).
 */
export function checkStockAvailability(
  items: { productId: string; quantity: number }[],
  stockMap: Map<string, number>,
): StockShortage[] {
  const shortages: StockShortage[] = [];
  for (const item of items) {
    const available = stockMap.get(item.productId) ?? 0;
    if (item.quantity > available) {
      shortages.push({
        productId: item.productId,
        requested: item.quantity,
        available,
      });
    }
  }
  return shortages;
}

/**
 * Computes stock deltas for a bill (negative = deducted).
 */
export function computeStockDeltas(
  items: { productId: string; quantity: number }[],
): { productId: string; delta: number }[] {
  return items.map((item) => ({
    productId: item.productId,
    delta: -Math.abs(item.quantity),   // always negative for sales
  }));
}

/**
 * Computes stock deltas for a void (reversal — positive).
 */
export function computeVoidStockDeltas(
  items: { productId: string; quantity: number }[],
): { productId: string; delta: number }[] {
  return items.map((item) => ({
    productId: item.productId,
    delta: Math.abs(item.quantity),    // always positive for reversals
  }));
}
