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

  it('counts CREDIT (khata) sales as revenue but not as drawer cash', () => {
    const withCredit: DailyBillSummaryInput[] = [
      ...sampleBills,
      { id: 'b6', total: '700.00', taxAmount: '106.78', paymentMode: 'CREDIT', status: 'PAID' },
    ];
    const result = reconcileDailyClosing(withCredit, cashFloat, '5500.00');
    expect(result.creditSales).toBe('700.00');
    expect(result.grossSales).toBe('6200.00');
    expect(result.expectedCashInDrawer).toBe('5500.00');
    expect(result.isBalanced).toBe(true);
    expect(result.paidBillsCount).toBe(5);
  });

  it('rejects unknown payment modes instead of silently dropping revenue', () => {
    expect(() => reconcileDailyClosing(
      [{ id: 'x', total: '10.00', taxAmount: '1.00', paymentMode: 'BITCOIN', status: 'PAID' }],
      cashFloat,
      '0',
    )).toThrow('Unknown payment mode');
  });

  it('throws when actual cash is negative or invalid string', () => {
    expect(() => reconcileDailyClosing(sampleBills, cashFloat, '-50.00')).toThrow(
      'Actual cash counted cannot be negative',
    );
    expect(() => reconcileDailyClosing(sampleBills, cashFloat, 'invalid')).toThrow();
  });

  it('allows manager overrides for cash, upi, and card sales and computes final total', () => {
    // Overriding cashSales: 1600.00 (from 1500.00), cardSales: 2600.00, upiSales: 1400.00
    // Expected cash in drawer = 5000 (opening) + 1600 (edited cash sales) - 1000 (withdrawals) = 5600.00
    const overrides = {
      cashSales: '1600.00',
      cardSales: '2600.00',
      upiSales: '1400.00',
    };
    const result = reconcileDailyClosing(sampleBills, cashFloat, '5600.00', overrides);
    expect(result.cashSales).toBe('1600.00');
    expect(result.cardSales).toBe('2600.00');
    expect(result.upiSales).toBe('1400.00');
    expect(result.grossSales).toBe('5600.00'); // 1600 + 2600 + 1400
    expect(result.expectedCashInDrawer).toBe('5600.00');
    expect(result.actualCashCounted).toBe('5600.00');
    expect(result.cashDiscrepancy).toBe('0.00');
    expect(result.isBalanced).toBe(true);
  });
});

describe('cash that moves without a bill', () => {
  const paid = [{ id: 'b1', total: '1000.00', taxAmount: '0.00', paymentMode: 'CASH', status: 'PAID' as const }];
  it('expected drawer = opening + cash sales + cash repayments - cash expenses - withdrawals', () => {
    const r = reconcileDailyClosing(paid, { openingCash: '500.00', cashWithdrawals: '100.00', cashRepayments: '250.00', cashExpenses: '75.50' }, '1574.50');
    expect(r.expectedCashInDrawer).toBe('1574.50');
    expect(r.cashRepayments).toBe('250.00');
    expect(r.cashExpenses).toBe('75.50');
    expect(r.isBalanced).toBe(true);
  });
  it('without them the figure is unchanged', () => {
    expect(reconcileDailyClosing(paid, { openingCash: '500.00' }, '1500.00').expectedCashInDrawer).toBe('1500.00');
  });
});

describe('sales returns deduction in closing', () => {
  it('deducts sales returns per payment channel and from total gross sales', () => {
    // Bills: CASH 1000, UPI 1500, CARD 2500 -> Gross billed = 5000.00
    const bills = [
      { id: 'b1', total: '1000.00', taxAmount: '150.00', paymentMode: 'CASH', status: 'PAID' as const },
      { id: 'b2', total: '1500.00', taxAmount: '225.00', paymentMode: 'UPI', status: 'PAID' as const },
      { id: 'b3', total: '2500.00', taxAmount: '375.00', paymentMode: 'CARD', status: 'PAID' as const },
    ];
    // Returns: UPI 1000 returned, CASH 200 returned
    const returns = [
      { refundMode: 'UPI', refundAmount: '1000.00', taxAmount: '150.00' },
      { refundMode: 'CASH', refundAmount: '200.00', taxAmount: '30.00' },
    ];
    // Opening 2000, actual cash = 2000 + 800 (net cash sales) = 2800.00
    const r = reconcileDailyClosing(bills, { openingCash: '2000.00' }, '2800.00', undefined, returns);
    expect(r.grossBilled).toBe('5000.00');
    expect(r.totalRefunds).toBe('1200.00');
    expect(r.grossSales).toBe('3800.00'); // 5000 - 1200
    expect(r.upiSales).toBe('500.00');   // 1500 - 1000
    expect(r.cashSales).toBe('800.00');  // 1000 - 200
    expect(r.cardSales).toBe('2500.00');
    expect(r.totalTax).toBe('570.00');   // 750 - 180
    expect(r.expectedCashInDrawer).toBe('2800.00');
    expect(r.isBalanced).toBe(true);
  });
});
