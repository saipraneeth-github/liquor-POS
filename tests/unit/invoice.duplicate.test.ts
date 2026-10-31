import { describe, it, expect } from 'vitest';
import {
  formatInvoiceDate,
  formatDuplicateInvoiceMessage,
  normalizeInvoiceNumber,
} from '../../src/modules/invoices/validate.engine.js';

describe('Duplicate Invoice Number Validation', () => {
  it('formats dates cleanly for display (e.g. 12 March 2025)', () => {
    const formatted = formatInvoiceDate(new Date('2025-03-12T10:00:00Z'));
    expect(formatted).toBe('12 March 2025');

    const formattedIso = formatInvoiceDate('2026-10-24');
    expect(formattedIso).toContain('October');
    expect(formattedIso).toContain('2026');
  });

  it('normalizes invoice number by trimming and lowercasing for case-insensitive check', () => {
    expect(normalizeInvoiceNumber('  INV-1234  ')).toBe('inv-1234');
    expect(normalizeInvoiceNumber('ICDC/2026/01')).toBe('icdc/2026/01');
    expect(normalizeInvoiceNumber(null)).toBe('');
  });

  it('generates friendly plain-English error message with exact date', () => {
    const msg = formatDuplicateInvoiceMessage('INV-1234', '2025-03-12');
    expect(msg).toBe('Invoice number INV-1234 has already been uploaded on 12 March 2025.');
  });

  it('handles fallback date when date is not available', () => {
    const msg = formatDuplicateInvoiceMessage('INV-999', null);
    expect(msg).toMatch(/^Invoice number INV-999 has already been uploaded on \d{1,2} [A-Z][a-z]+ \d{4}\.$/);
  });
});
