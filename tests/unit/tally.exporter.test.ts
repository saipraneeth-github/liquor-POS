import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  vouchersToTallyXml,
  tallyParentGroup,
  xmlEscape,
  tallyDate,
  tallyVoucherTypeName,
  type TallyVoucher,
} from '../../src/modules/accounting/tally.exporter.js';

const NAMES = new Map([
  ['CASH', 'Cash in Hand'],
  ['SALES', 'Sales Account'],
  ['OUTPUT_GST', 'Output GST'],
  ['DISCOUNT_ALLOWED', 'Discount Allowed'],
  ['EXPENSE_RENT', 'Rent & Lease <Shop>'],
]);

const SALE: TallyVoucher = {
  voucherNumber: 'JV-MAIN-20261024-ABCD1234',
  voucherDate: '2026-10-24',
  voucherType: 'SALES',
  narration: 'Sales bill MAIN-2026-000001 (CASH)',
  lines: [
    { ledgerCode: 'CASH', debit: '990.00', credit: '0.00' },
    { ledgerCode: 'DISCOUNT_ALLOWED', debit: '10.00', credit: '0.00' },
    { ledgerCode: 'SALES', debit: '0.00', credit: '847.46' },
    { ledgerCode: 'OUTPUT_GST', debit: '0.00', credit: '152.54' },
  ],
};

const EXPENSE: TallyVoucher = {
  voucherNumber: 'JV-MAIN-20261025-0000FFFF',
  voucherDate: '2026-10-25',
  voucherType: 'PAYMENT',
  narration: `Rent "Oct" & owner's <share>`,
  lines: [
    { ledgerCode: 'EXPENSE_RENT', debit: '1500.00', credit: '0.00' },
    { ledgerCode: 'CASH', debit: '0.00', credit: '1500.00' },
  ],
};

function between(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

describe('helpers', () => {
  it('escapes the five XML special characters', () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
  it('drops characters that are illegal in XML 1.0 (keeps tab/newline)', () => {
    expect(xmlEscape('a\u0000b\u0001c\u001Fd\te\nf\uFFFEg')).toBe('abcd\te\nfg');
  });
  it('formats Tally dates and voucher type names', () => {
    expect(tallyDate('2026-01-05')).toBe('20260105');
    expect(() => tallyDate('05/01/2026')).toThrow();
    expect(tallyVoucherTypeName('SALES')).toBe('Sales');
    expect(tallyVoucherTypeName('RECEIPT')).toBe('Receipt');
    expect(tallyVoucherTypeName('UNKNOWN')).toBe('Journal');
  });
});

describe('vouchersToTallyXml', () => {
  const xml = vouchersToTallyXml([SALE, EXPENSE], NAMES, 'Main & Co <Liquors>');

  it('produces the Tally import envelope', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const tag of ['ENVELOPE', 'HEADER', 'BODY', 'IMPORTDATA', 'REQUESTDESC', 'STATICVARIABLES', 'REQUESTDATA']) {
      expect(xml).toContain(`<${tag}>`);
      expect(xml).toContain(`</${tag}>`);
    }
    expect(between(xml, 'TALLYREQUEST')).toEqual(['Import Data']);
    expect(between(xml, 'REPORTNAME')).toEqual(['Vouchers']);
    expect(between(xml, 'SVCURRENTCOMPANY')).toEqual(['Main &amp; Co &lt;Liquors&gt;']);
    expect(xml.match(/<TALLYMESSAGE xmlns:UDF="TallyUDF">/g)).toHaveLength(2);
    expect(xml).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create">');
    expect(xml).toContain('<VOUCHER VCHTYPE="Payment" ACTION="Create">');
    expect(between(xml, 'DATE')).toEqual(['20261024', '20261025']);
    expect(between(xml, 'VOUCHERTYPENAME')).toEqual(['Sales', 'Payment']);
    expect(between(xml, 'VOUCHERNUMBER')).toEqual([SALE.voucherNumber, EXPENSE.voucherNumber]);
  });

  it('uses Tally sign convention: debit negative + Yes, credit positive + No', () => {
    const entries = between(xml, 'ALLLEDGERENTRIES.LIST');
    expect(entries).toHaveLength(6);
    const cash = entries[0];
    expect(cash).toContain('<LEDGERNAME>Cash in Hand</LEDGERNAME>');
    expect(cash).toContain('<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>');
    expect(cash).toContain('<AMOUNT>-990.00</AMOUNT>');
    const sales = entries[2];
    expect(sales).toContain('<LEDGERNAME>Sales Account</LEDGERNAME>');
    expect(sales).toContain('<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>');
    expect(sales).toContain('<AMOUNT>847.46</AMOUNT>');
  });

  it('escapes narration and ledger names', () => {
    expect(xml).toContain('<NARRATION>Rent &quot;Oct&quot; &amp; owner&apos;s &lt;share&gt;</NARRATION>');
    expect(xml).toContain('<LEDGERNAME>Rent &amp; Lease &lt;Shop&gt;</LEDGERNAME>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('per-voucher amounts net to zero', () => {
    const blocks = xml.split('<VOUCHER ').slice(1);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const net = between(block, 'AMOUNT').reduce((acc, a) => acc.plus(a), new Decimal(0));
      expect(net.isZero()).toBe(true);
    }
  });

  it('falls back to the ledger code when no name is known (record lookup too)', () => {
    const out = vouchersToTallyXml([SALE], { CASH: 'Cash' }, 'X');
    expect(out).toContain('<LEDGERNAME>Cash</LEDGERNAME>');
    expect(out).toContain('<LEDGERNAME>SALES</LEDGERNAME>');
  });

  it('empty range produces a valid envelope with no vouchers', () => {
    const out = vouchersToTallyXml([], NAMES, 'Empty Co');
    expect(out).toContain('<ENVELOPE>');
    expect(out).toContain('<REQUESTDATA>');
    expect(out).toContain('</REQUESTDATA>');
    expect(out).toContain('</ENVELOPE>');
    expect(out).not.toContain('<VOUCHER');
    expect(out).not.toContain('<TALLYMESSAGE');
    // Balanced tags
    const opens = (out.match(/<[A-Z][A-Z.]*[ >]/g) ?? []).length;
    const closes = (out.match(/<\/[A-Z][A-Z.]*>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('includes <LEDGER> master definitions with Tally parent groups when ledgers are supplied', () => {
    expect(tallyParentGroup({ code: 'CASH', group: 'ASSET' })).toBe('Cash-in-Hand');
    expect(tallyParentGroup({ code: 'SALES', group: 'INCOME' })).toBe('Sales Accounts');
    expect(tallyParentGroup({ code: 'EXPENSE_RENT', group: 'EXPENSE' })).toBe('Indirect Expenses');

    const withMasters = vouchersToTallyXml([SALE], NAMES, 'Main Co', [
      { code: 'CASH', name: 'Cash in Hand', group: 'ASSET' },
      { code: 'SALES', name: 'Sales Account', group: 'INCOME' },
    ]);
    expect(withMasters).toContain('<LEDGER NAME="Cash in Hand" ACTION="Create">');
    expect(withMasters).toContain('<PARENT>Cash-in-Hand</PARENT>');
    expect(withMasters).toContain('<LEDGER NAME="Sales Account" ACTION="Create">');
    expect(withMasters).toContain('<PARENT>Sales Accounts</PARENT>');
  });
});
