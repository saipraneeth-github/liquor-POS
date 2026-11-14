import { describe, it, expect } from 'vitest';
import { bankFormatToTable, ofxToTable, parseAmount, qifToTable, sniffBankFormat } from '../../src/modules/bank/bank-formats.js';

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>INR
<BANKTRANLIST>
<DTSTART>20240101
<DTEND>20240131
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240105120000.000[+5.5:IST]
<TRNAMT>-12000.00
<FITID>F001
<NAME>NEFT HOTEL RENT
<MEMO>JAN RENT
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240110
<TRNAMT>5,000.50
<FITID>F002
<CHECKNUM>778
<NAME>UPI CUSTOMER
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>93000.50<DTASOF>20240131</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240201</DTPOSTED><TRNAMT>-30000</TRNAMT><FITID>X1</FITID><NAME>SALARY STAFF</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>70000</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('sniffBankFormat', () => {
  it('recognises OFX (SGML and XML) and QIF, and leaves a CSV alone', () => {
    expect(sniffBankFormat(OFX_SGML)).toBe('OFX');
    expect(sniffBankFormat(OFX_XML)).toBe('OFX');
    expect(sniffBankFormat('!Type:Bank\nD01/02/2024\nT-10\n^')).toBe('QIF');
    expect(sniffBankFormat('Date,Narration,Debit,Credit\n01/02/2024,x,10,')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('reads signs, thousands commas, decimal commas and brackets', () => {
    expect(parseAmount('-12,000.50')?.toFixed(2)).toBe('-12000.50');
    expect(parseAmount('1.234,56')?.toFixed(2)).toBe('1234.56');
    expect(parseAmount('12,5')?.toFixed(2)).toBe('12.50');
    expect(parseAmount('(250.00)')?.toFixed(2)).toBe('-250.00');
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('OFX', () => {
  it('reads an old SGML file: dates, signed amounts, description, reference and the ledger balance', () => {
    const t = ofxToTable(OFX_SGML);
    expect(t.rows).toEqual([
      ['Date', 'Description', 'Reference', 'Debit', 'Credit'],
      ['2024-01-05', 'NEFT HOTEL RENT JAN RENT', 'F001', '12000.00', ''],
      ['2024-01-10', 'UPI CUSTOMER', '778', '', '5000.50'],
    ]);
    expect(t.hints).toEqual({ opening: null, closing: '93000.50' });
  });

  it('reads an XML file', () => {
    const t = ofxToTable(OFX_XML);
    expect(t.rows[1]).toEqual(['2024-02-01', 'SALARY STAFF', 'X1', '30000.00', '']);
    expect(t.hints.closing).toBe('70000.00');
  });

  it('reports a transaction it cannot read instead of dropping it silently', () => {
    const t = ofxToTable('<OFX><STMTTRN><DTPOSTED>20240105<TRNAMT>-5</STMTTRN><STMTTRN><DTPOSTED>20240106<TRNAMT>oops</STMTTRN></OFX>');
    expect(t.rows).toHaveLength(2);
    expect(t.warnings).toContain('ROWS_WITHOUT_AMOUNT:1');
  });

  it('refuses a file with no transactions', () => {
    expect(() => ofxToTable('<OFX><BANKTRANLIST></BANKTRANLIST></OFX>')).toThrow(/no transactions/i);
  });
});

describe('QIF', () => {
  const qif = (dates: [string, string]) => `!Type:Bank\nD${dates[0]}\nT-12,000.00\nPHotel rent\nMJan\nN101\n^\nD${dates[1]}\nT5000.00\nPCustomer\n^\n`;

  it('reads day-first dates when one of them proves it', () => {
    const t = qifToTable(qif(['25/01/2024', '03/02/2024']));
    expect(t.rows[1]).toEqual(['2024-01-25', 'Hotel rent Jan', '101', '12000.00', '']);
    expect(t.rows[2]).toEqual(['2024-02-03', 'Customer', '', '', '5000.00']);
    expect(t.warnings).toEqual([]);
  });

  it('reads month-first dates and the 12/31\'24 style when one of them proves it', () => {
    const t = qifToTable(qif(["01/25'24", "02/03'24"]));
    expect(t.rows[1][0]).toBe('2024-01-25');
    expect(t.rows[2][0]).toBe('2024-02-03');
  });

  it('assumes day first when every date is ambiguous, and says so', () => {
    const t = qifToTable(qif(['01/02/2024', '03/04/2024']));
    expect(t.rows[1][0]).toBe('2024-02-01');
    expect(t.warnings).toContain('QIF_DATES_ASSUMED_DAY_FIRST');
  });

  it('skips non-bank sections', () => {
    const t = qifToTable('!Type:Bank\nD25/01/2024\nT-10\nPA\n^\n!Type:Invst\nD25/01/2024\nT-99\nPB\n^\n');
    expect(t.rows).toHaveLength(2);
  });
});

describe('bankFormatToTable', () => {
  it('returns null for anything else', () => {
    expect(bankFormatToTable('Date,Amount\n1,2')).toBeNull();
  });
});
