import { describe, expect, it } from 'vitest';
import { inr } from '../../frontend/src/components/ui';
import { MESSAGES } from '../../frontend/src/i18n/messages';

describe('staff-facing amounts and labels', () => {
  it.each(['hi', 'te'] as const)('translates the accounting workspace and expense form in %s', (lang) => {
    for (const key of ['Record expense', 'Save expense', 'Your shop', 'Choose the shop for this expense.', 'View accounts', 'Money received and paid, day by day.', 'Could not load this report. Try again.', 'Enter an amount above zero, with up to two decimal places.', 'UPI sales amount', 'Card sales amount', 'Khata / customer credit sales amount']) {
      expect(MESSAGES[lang][key]).toBeTruthy();
      expect(MESSAGES[lang][key]).not.toBe(key);
    }
  });
  it.each([
    ['0.00', '₹0.00'],
    ['1234567.89', '₹12,34,567.89'],
    ['12.50', '₹12.50'],
    ['-123456.78', '₹-1,23,456.78'],
  ])('formats %s with Indian grouping and two decimals', (amount, expected) => {
    expect(inr(amount)).toBe(expected);
  });

  it.each(['hi', 'te'] as const)('provides %s translations for staff and dialog labels', (lang) => {
    for (const label of ['Staff members', 'Staff & Billing Counters', 'Close', 'Daily accounts', 'Reports & export', 'Review entries', 'Finish checking', 'Statement tools', 'Accept suggested matches', 'Rules for personal and other non-shop transactions', 'Review one by one', 'All entries & tools', 'Already in our books', 'Missing from our books', 'Not for this shop', 'Previous', 'Next', 'Statement totals', 'Money in total', 'Money out total', 'What was this money received for?', 'What was this money paid for?', 'Select the book entries covered by this bank transaction. Select more than one for a settlement.', 'No matching book entries found', 'Selected book entries', 'Bank transaction', 'Balances & checks']) {
      expect(MESSAGES[lang][label]).toBeTruthy();
      expect(MESSAGES[lang][label]).not.toBe(label);
    }
  });
});
