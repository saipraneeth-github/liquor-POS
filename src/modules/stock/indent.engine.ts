export interface IndentProductInput {
  productId: string;
  productName: string;
  currentStock: number;
  totalSoldInPeriod: number;
  periodDays: number;
  leadTimeDays: number;
  bufferDays?: number;
  casePackSize?: number;
}

export interface IndentEstimationResult {
  productId: string;
  productName: string;
  velocityPerDay: number;
  daysOfInventoryRemaining: number;
  targetStockLevel: number;
  suggestedReorderQty: number;
  isStockoutRisk: boolean;
}

/**
 * Calculates daily sales velocity: total units sold divided by period days.
 */
export function calculateSalesVelocity(totalSold: number, periodDays: number): number {
  if (periodDays <= 0) {
    throw new Error('Period days must be greater than zero');
  }
  if (totalSold < 0) {
    throw new Error('Total sold quantity cannot be negative');
  }
  return totalSold / periodDays;
}

/**
 * Estimates indent / reorder quantity based on velocity, lead time, and buffer days.
 */
export function estimateIndent(input: IndentProductInput): IndentEstimationResult {
  const velocity = calculateSalesVelocity(input.totalSoldInPeriod, input.periodDays);
  const bufferDays = input.bufferDays ?? 3;
  const leadTimeDays = input.leadTimeDays;

  // Days of inventory remaining
  const daysRemaining = velocity > 0 ? input.currentStock / velocity : Infinity;

  // Target stock level to cover lead time and buffer period
  const targetDays = leadTimeDays + bufferDays;
  const targetStock = Math.ceil(velocity * targetDays);

  // Deficit calculation
  const deficit = Math.max(0, targetStock - input.currentStock);

  let suggestedReorder = deficit;

  // If there's an MOQ / case pack size constraint, round up to nearest multiple
  if (suggestedReorder > 0 && input.casePackSize && input.casePackSize > 1) {
    suggestedReorder = Math.ceil(suggestedReorder / input.casePackSize) * input.casePackSize;
  }

  // Stockout risk if current inventory covers less than lead time + safety buffer
  const isStockoutRisk = velocity > 0 && daysRemaining <= targetDays;

  return {
    productId: input.productId,
    productName: input.productName,
    velocityPerDay: Number(velocity.toFixed(2)),
    daysOfInventoryRemaining: daysRemaining === Infinity ? Infinity : Number(daysRemaining.toFixed(2)),
    targetStockLevel: targetStock,
    suggestedReorderQty: suggestedReorder,
    isStockoutRisk,
  };
}
