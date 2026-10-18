import { describe, it, expect } from 'vitest';
import {
  reconcileDailyClosing,
  type DailyBillSummaryInput,
  type CashFloatInput,
} from '../../src/modules/closing/closing.engine.js';

describe('reconcileDailyClosing', () => {
  const sampleBills: DailyBillSummaryInput[] = [
    { id: 'b1', total: '1000.00', taxAmount: '152.54', paymentMode: 'CASH', status: 'PAID' },
    { id: 'b2', total: '2500.00', taxAmount: '381.36', paymentMode: 'CARD', status: 'PAID' },
    { id: 'b3', total: '1500.00', taxAmount: '228.81', paymentMode: 'UPI', status: 'PAID' },
    { id: 'b4', total: '500.00', taxAmount: '76.27', paymentMode: 'CASH', status: 'PAID' },
    { id: 'b5', total: '800.00', taxAmount: '122.03', paymentMode: 'CASH', status: 'VOIDED' }, // voided should be excluded from active totals
  ];

  const cashFloat: CashFloatInput = {
    openingCash: '5000.00',
    cashWithdrawals: '1000.00', // e.g., cash dropped to bank or petty cash payout
  };

  it('correctly aggregates payment modes and calculates expected cash', () => {
    // Paid cash bills: b1 (1000) + b4 (500) = 1500.00
    // Expected cash in drawer = 5000 (opening) + 1500 (sales) - 1000 (payout) = 5500.00
    const actualCashCounted = '5500.00';

    const result = reconcileDailyClosing(sampleBills, cashFloat, actualCashCounted);

    expect(result.cashSales).toBe('1500.00');
    expect(result.cardSales).toBe('2500.00');
    expect(result.upiSales).toBe('1500.00');
    expect(result.grossSales).toBe('5500.00'); // 1500 (cash) + 2500 (card) + 1500 (upi) = 5500.00
    expect(result.expectedCashInDrawer).toBe('5500.00');
    expect(result.actualCashCounted).toBe('5500.00');
    expect(result.cashDiscrepancy).toBe('0.00');
    expect(result.isBalanced).toBe(true);
    expect(result.totalBillsCount).toBe(5);
    expect(result.paidBillsCount).toBe(4);
    expect(result.voidedBillsCount).toBe(1);
  });

  it('detects cash shortage correctly', () => {
    const actualCashCounted = '5400.00'; // 100 rupees missing
    const result = reconcileDailyClosing(sampleBills, cashFloat, actualCashCounted);

    expect(result.cashDiscrepancy).toBe('-100.00');
    expect(result.isBalanced).toBe(false);
  });

  it('detects cash excess correctly', () => {
    const actualCashCounted = '5550.00'; // 50 rupees extra
    const result = reconcileDailyClosing(sampleBills, cashFloat, actualCashCounted);

    expect(result.cashDiscrepancy).toBe('50.00');
    expect(result.isBalanced).toBe(false);
  });

  it('throws when actual cash is negative or invalid string', () => {
    expect(() => reconcileDailyClosing(sampleBills, cashFloat, '-50.00')).toThrow(
      'Actual cash counted cannot be negative',
    );
    expect(() => reconcileDailyClosing(sampleBills, cashFloat, 'invalid')).toThrow();
  });
});
