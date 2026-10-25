import { Decimal } from 'decimal.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface TallyVoucherLine {
  ledgerCode: string;
  debit: string;
  credit: string;
}

export interface TallyVoucher {
  voucherNumber: string;
  voucherDate: string;   // YYYY-MM-DD
  voucherType: string;   // SALES | PURCHASE | PAYMENT | RECEIPT | JOURNAL | CONTRA
  narration: string;
  lines: TallyVoucherLine[];
}

export interface TallyLedgerMaster {
  code: string;
  name: string;
  group: string;         // ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
}

export type LedgerNameLookup = Map<string, string> | Record<string, string>;

// ─── HELPERS ────────────────────────────────────────────────────────────────

const LEDGER_PARENT_BY_CODE: Record<string, string> = {
  CASH:             'Cash-in-Hand',
  BANK:             'Bank Accounts',
  SUNDRY_DEBTORS:   'Sundry Debtors',
  SUNDRY_CREDITORS: 'Sundry Creditors',
  OUTPUT_GST:       'Duties & Taxes',
  INPUT_GST:        'Duties & Taxes',
  SALES:            'Sales Accounts',
  PURCHASES:        'Purchase Accounts',
  OWNER_EQUITY:     'Capital Account',
  DISCOUNT_ALLOWED: 'Indirect Expenses',
  BREAKAGE_LOSS:    'Indirect Expenses',
};

const LEDGER_PARENT_BY_GROUP: Record<string, string> = {
  ASSET:     'Current Assets',
  LIABILITY: 'Current Liabilities',
  EQUITY:    'Capital Account',
  INCOME:    'Indirect Incomes',
  EXPENSE:   'Indirect Expenses',
};

export function tallyParentGroup(ledger: Pick<TallyLedgerMaster, 'code' | 'group'>): string {
  return LEDGER_PARENT_BY_CODE[ledger.code.toUpperCase()] ?? LEDGER_PARENT_BY_GROUP[ledger.group.toUpperCase()] ?? 'Suspense A/c';
}

const VOUCHER_TYPE_NAMES: Record<string, string> = {
  SALES:    'Sales',
  PURCHASE: 'Purchase',
  PAYMENT:  'Payment',
  RECEIPT:  'Receipt',
  JOURNAL:  'Journal',
  CONTRA:   'Contra',
};

// Characters outside the XML 1.0 Char production (C0 controls except tab/LF/CR, lone
// surrogates, U+FFFE/U+FFFF). A single one makes Tally reject the whole import file.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlEscape(value: string): string {
  return value
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function tallyVoucherTypeName(voucherType: string): string {
  return VOUCHER_TYPE_NAMES[voucherType.toUpperCase()] ?? 'Journal';
}

/** '2026-10-24' → '20261024' */
export function tallyDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(isoDate)) throw new Error(`Invalid voucher date ${isoDate}`);
  return isoDate.slice(0, 10).replace(/-/g, '');
}

function lookupName(names: LedgerNameLookup, code: string): string {
  const name = names instanceof Map ? names.get(code) : names[code];
  return name ?? code;
}

/**
 * Tally sign convention: a debit is entered as a NEGATIVE amount with ISDEEMEDPOSITIVE=Yes,
 * a credit as a POSITIVE amount with ISDEEMEDPOSITIVE=No.
 */
export function tallyLedgerEntry(line: TallyVoucherLine): { isDeemedPositive: 'Yes' | 'No'; amount: string } {
  const debit = new Decimal(line.debit);
  const credit = new Decimal(line.credit);
  if (debit.greaterThan(0)) return { isDeemedPositive: 'Yes', amount: debit.neg().toFixed(2) };
  return { isDeemedPositive: 'No', amount: credit.toFixed(2) };
}

// ─── EXPORTER ───────────────────────────────────────────────────────────────

/** Builds a Tally Prime / ERP 9 "Import Data" XML envelope (with optional <LEDGER> masters before <VOUCHER>s). */
export function vouchersToTallyXml(
  vouchers: TallyVoucher[],
  ledgerNameByCode: LedgerNameLookup,
  companyName: string,
  ledgers?: TallyLedgerMaster[],
): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<ENVELOPE>');
  out.push('  <HEADER>');
  out.push('    <TALLYREQUEST>Import Data</TALLYREQUEST>');
  out.push('  </HEADER>');
  out.push('  <BODY>');
  out.push('    <IMPORTDATA>');
  out.push('      <REQUESTDESC>');
  out.push('        <REPORTNAME>Vouchers</REPORTNAME>');
  out.push('        <STATICVARIABLES>');
  out.push(`          <SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY>`);
  out.push('        </STATICVARIABLES>');
  out.push('      </REQUESTDESC>');
  out.push('      <REQUESTDATA>');

  for (const l of ledgers ?? []) {
    const escapedName = xmlEscape(l.name);
    const parent = xmlEscape(tallyParentGroup(l));
    out.push('        <TALLYMESSAGE xmlns:UDF="TallyUDF">');
    out.push(`          <LEDGER NAME="${escapedName}" ACTION="Create">`);
    out.push('            <NAME.LIST>');
    out.push(`              <NAME>${escapedName}</NAME>`);
    out.push('            </NAME.LIST>');
    out.push(`            <PARENT>${parent}</PARENT>`);
    out.push('          </LEDGER>');
    out.push('        </TALLYMESSAGE>');
  }

  for (const v of vouchers) {
    const typeName = xmlEscape(tallyVoucherTypeName(v.voucherType));
    out.push('        <TALLYMESSAGE xmlns:UDF="TallyUDF">');
    out.push(`          <VOUCHER VCHTYPE="${typeName}" ACTION="Create">`);
    out.push(`            <DATE>${tallyDate(v.voucherDate)}</DATE>`);
    out.push(`            <VOUCHERTYPENAME>${typeName}</VOUCHERTYPENAME>`);
    out.push(`            <VOUCHERNUMBER>${xmlEscape(v.voucherNumber)}</VOUCHERNUMBER>`);
    out.push(`            <NARRATION>${xmlEscape(v.narration)}</NARRATION>`);
    for (const line of v.lines) {
      const entry = tallyLedgerEntry(line);
      out.push('            <ALLLEDGERENTRIES.LIST>');
      out.push(`              <LEDGERNAME>${xmlEscape(lookupName(ledgerNameByCode, line.ledgerCode))}</LEDGERNAME>`);
      out.push(`              <ISDEEMEDPOSITIVE>${entry.isDeemedPositive}</ISDEEMEDPOSITIVE>`);
      out.push(`              <AMOUNT>${entry.amount}</AMOUNT>`);
      out.push('            </ALLLEDGERENTRIES.LIST>');
    }
    out.push('          </VOUCHER>');
    out.push('        </TALLYMESSAGE>');
  }

  out.push('      </REQUESTDATA>');
  out.push('    </IMPORTDATA>');
  out.push('  </BODY>');
  out.push('</ENVELOPE>');
  return out.join('\n') + '\n';
}
