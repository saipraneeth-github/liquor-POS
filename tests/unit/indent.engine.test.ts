import { describe, it, expect } from 'vitest';
import {
  calculateSalesVelocity,
  estimateIndent,
  type IndentProductInput,
} from '../../src/modules/stock/indent.engine.js';

describe('calculateSalesVelocity', () => {
  it('calculates average daily sales velocity correctly', () => {
    // 30 bottles sold over 10 days = 3.0 bottles/day
    const velocity = calculateSalesVelocity(30, 10);
    expect(velocity).toBe(3);
  });

  it('handles zero sales days gracefully', () => {
    const velocity = calculateSalesVelocity(0, 14);
    expect(velocity).toBe(0);
  });

  it('throws on non-positive period days', () => {
    expect(() => calculateSalesVelocity(10, 0)).toThrow('Period days must be greater than zero');
    expect(() => calculateSalesVelocity(10, -5)).toThrow('Period days must be greater than zero');
  });

  it('throws on negative sales quantity', () => {
    expect(() => calculateSalesVelocity(-10, 7)).toThrow('Total sold quantity cannot be negative');
  });
});

describe('estimateIndent', () => {
  it('suggests correct reorder quantity when stock is below reorder point', () => {
    const input: IndentProductInput = {
      productId: 'p-whisky-750',
      productName: 'Royal Stag 750ml',
      currentStock: 10,
      totalSoldInPeriod: 60,
      periodDays: 30, // velocity = 2 bottles/day
      leadTimeDays: 5, // lead time demand = 10
      bufferDays: 3, // safety stock = 6 => total target = 16
    };

    const result = estimateIndent(input);
    // target stock = 2 * (5 + 3) = 16. Current = 10. Suggested = 6.
    expect(result.velocityPerDay).toBe(2);
    expect(result.daysOfInventoryRemaining).toBe(5); // 10 / 2 = 5 days
    expect(result.targetStockLevel).toBe(16);
    expect(result.suggestedReorderQty).toBe(6);
    expect(result.isStockoutRisk).toBe(true); // 5 days remaining <= leadTime (5) + buffer (3)
  });

  it('suggests 0 reorder quantity when stock is healthy', () => {
    const input: IndentProductInput = {
      productId: 'p-beer-650',
      productName: 'Kingfisher Strong 650ml',
      currentStock: 100,
      totalSoldInPeriod: 90,
      periodDays: 30, // velocity = 3 cans/day
      leadTimeDays: 3,
      bufferDays: 2, // target = 3 * 5 = 15
    };

    const result = estimateIndent(input);
    expect(result.suggestedReorderQty).toBe(0);
    expect(result.isStockoutRisk).toBe(false);
    expect(result.daysOfInventoryRemaining).toBeCloseTo(33.33, 1);
  });

  it('respects minimum order quantity (MOQ) and case pack sizing', () => {
    const input: IndentProductInput = {
      productId: 'p-vodka-750',
      productName: 'Absolut 750ml',
      currentStock: 2,
      totalSoldInPeriod: 30,
      periodDays: 30, // velocity = 1 bottle/day
      leadTimeDays: 4,
      bufferDays: 2, // target = 6. Deficit = 6 - 2 = 4.
      casePackSize: 12, // supplier only sells in cases of 12
    };

    const result = estimateIndent(input);
    // Deficit is 4, but pack size is 12, so must round up to 12
    expect(result.suggestedReorderQty).toBe(12);
  });

  it('handles zero velocity products without division by zero', () => {
    const input: IndentProductInput = {
      productId: 'p-slow-mover',
      productName: 'Expensive Cognac',
      currentStock: 5,
      totalSoldInPeriod: 0,
      periodDays: 30,
      leadTimeDays: 7,
      bufferDays: 3,
    };

    const result = estimateIndent(input);
    expect(result.velocityPerDay).toBe(0);
    expect(result.daysOfInventoryRemaining).toBe(Infinity);
    expect(result.suggestedReorderQty).toBe(0);
    expect(result.isStockoutRisk).toBe(false);
  });
});
