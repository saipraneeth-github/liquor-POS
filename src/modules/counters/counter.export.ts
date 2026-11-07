import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches } from '../../db/schema.js';
import { NotFoundError } from '../../lib/errors.js';
import { getSheet, listSheets } from './counter.service.js';

// ─── EXPORT / CSV ────────────────────────────────────────────────────────────

export function sheetToCsv(sheet: {
  sheetDate: string;
  status: string;
  totalRevenue: string;
  lines: Array<{
    productName: string;
    packQuantity?: number | null;
    openingBottles: number;
    inwardBottles: number;
    posSoldBottles?: number;
    soldBottles: number;
    closingBottles: number;
    closingSplit?: { cases: number; loose: number } | null;
    sellingRate: string;
    lineRevenue: string;
  }>;
}, branchName?: string): string {
  const sanitize = (val: string | number | undefined | null) => {
    if (val === undefined || val === null) return '';
    let s = String(val);
    // Spreadsheet formula injection: product names come from OCR'd / imported data, so neutralise
    // cells that Excel would evaluate as a formula (negative numbers are plain numerics, leave them).
    if (/^[=+@\t\r]/.test(s) || (s.startsWith('-') && Number.isNaN(Number(s)))) s = `'${s}`;
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headerLines = [
    `Daily Counter Sheet${branchName ? ` - ${branchName}` : ''}`,
    `Sheet Date: ${sheet.sheetDate}`,
    `Status: ${sheet.status}`,
    `Total Revenue: ₹${sheet.totalRevenue}`,
    '',
    [
      'Product',
      'Pack Qty',
      'Opening (Bottles)',
      'Inward (Bottles)',
      'POS Sold (Bottles)',
      'Counter Sold (Bottles)',
      'Closing (Bottles)',
      'Closing Cases',
      'Closing Loose',
      'Rate (MRP)',
      'Line Revenue',
    ].map(sanitize).join(','),
  ];

  const dataRows = sheet.lines.map((l) => [
    sanitize(l.productName),
    sanitize(l.packQuantity ?? 1),
    l.openingBottles,
    l.inwardBottles,
    l.posSoldBottles ?? 0,
    l.soldBottles,
    l.closingBottles,
    l.closingSplit?.cases ?? '',
    l.closingSplit?.loose ?? '',
    sanitize(l.sellingRate),
    sanitize(l.lineRevenue),
  ].join(','));

  const footer = [
    '',
    ['Total', '', '', '', '', '', '', '', '', '', sanitize(sheet.totalRevenue)].join(','),
  ];

  return [...headerLines, ...dataRows, ...footer].join('\r\n');
}

export async function getSheetCsv(id: string): Promise<{ csv: string; filename: string }> {
  const sheet = await getSheet(id);
  const csv = sheetToCsv(sheet);
  const filename = `counter-sheet-${sheet.sheetDate}.csv`;
  return { csv, filename };
}

export async function getBranchSheetCsv(branchId: string, date?: string): Promise<{ csv: string; filename: string }> {
  const sheets = await listSheets(branchId, date);
  if (sheets.length === 0) {
    throw new NotFoundError(date ? `No counter sheet found for date ${date}` : 'No counter sheets found for this branch');
  }
  const sheet = await getSheet(sheets[0].id);
  const csv = sheetToCsv(sheet);
  const filename = `counter-sheet-${sheet.sheetDate}.csv`;
  return { csv, filename };
}


// ─── EXCEL (.XLSX) EXPORT WITH TABLES & BORDERS ───────────────────────────────

export async function sheetToExcel(
  sheet: {
    sheetDate: string;
    status: string;
    totalRevenue: string;
    lines: Array<{
      productName: string;
      packQuantity?: number | null;
      openingBottles: number;
      inwardBottles: number;
      posSoldBottles?: number;
      soldBottles: number;
      closingBottles: number;
      closingSplit?: { cases: number; loose: number } | null;
      sellingRate: string;
      lineRevenue: string;
    }>;
  },
  branchName?: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Liquor Counter POS';
  wb.created = new Date();

  const ws = wb.addWorksheet('Counter Sheet', {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 6 }],
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = [
    { key: 'sn', width: 6 },
    { key: 'product', width: 40 },
    { key: 'packQty', width: 10 },
    { key: 'opening', width: 14 },
    { key: 'inward', width: 14 },
    { key: 'available', width: 14 },
    { key: 'posSold', width: 14 },
    { key: 'closing', width: 15 },
    { key: 'cases', width: 13 },
    { key: 'loose', width: 13 },
    { key: 'sold', width: 14 },
    { key: 'status', width: 24 },
    { key: 'rate', width: 15 },
    { key: 'revenue', width: 18 },
  ];

  // 1. Title Row
  ws.mergeCells('A1:N1');
  const titleCell = ws.getCell('A1');
  titleCell.value = '📋 DAILY COUNTER SHEET & STOCK RECONCILIATION';
  titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF1E3A8A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 30;

  // 2. Metadata Row
  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = `Store: ${branchName ?? 'Main Counter Store'}`;
  ws.getCell('A2').font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF334155' } };
  ws.getCell('A2').alignment = { vertical: 'middle', horizontal: 'left' };

  ws.mergeCells('G2:N2');
  ws.getCell('G2').value = `Sheet Date: ${sheet.sheetDate}   |   Status: ${sheet.status}   |   Exported: ${new Date().toLocaleString('en-IN')}`;
  ws.getCell('G2').font = { name: 'Calibri', size: 10, color: { argb: 'FF64748B' } };
  ws.getCell('G2').alignment = { vertical: 'middle', horizontal: 'right' };
  ws.getRow(2).height = 20;

  // 3. Spacing
  ws.getRow(3).height = 6;

  // 4. KPI Summary Bar (Row 4)
  const totalSold = sheet.lines.reduce((s, l) => s + (l.soldBottles > 0 ? l.soldBottles : 0), 0);
  const totalPos = sheet.lines.reduce((s, l) => s + (l.posSoldBottles ?? 0), 0);
  const surplusLines = sheet.lines.filter((l) => l.closingBottles > (l.openingBottles + l.inwardBottles));
  const surplusBtls = surplusLines.reduce((s, l) => s + (l.closingBottles - (l.openingBottles + l.inwardBottles)), 0);
  const shortageLines = sheet.lines.filter((l) => {
    const avail = l.openingBottles + l.inwardBottles;
    const exp = Math.max(0, avail - (l.posSoldBottles ?? 0));
    return (l.posSoldBottles ?? 0) > 0 && l.closingBottles < exp;
  });
  const shortageBtls = shortageLines.reduce((s, l) => {
    const avail = l.openingBottles + l.inwardBottles;
    const exp = Math.max(0, avail - (l.posSoldBottles ?? 0));
    return s + (exp - l.closingBottles);
  }, 0);

  const kpiBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  };

  ws.mergeCells('A4:C4');
  const kpi1 = ws.getCell('A4');
  kpi1.value = `💰 Total Revenue: ₹${parseFloat(sheet.totalRevenue).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  kpi1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  kpi1.font = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF0F172A' } };
  kpi1.alignment = { vertical: 'middle', horizontal: 'center' };
  kpi1.border = kpiBorder;

  ws.mergeCells('D4:F4');
  const kpi2 = ws.getCell('D4');
  kpi2.value = `📦 Total Bottles Sold: ${totalSold}`;
  kpi2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  kpi2.font = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF0F172A' } };
  kpi2.alignment = { vertical: 'middle', horizontal: 'center' };
  kpi2.border = kpiBorder;

  ws.mergeCells('G4:I4');
  const kpi3 = ws.getCell('G4');
  kpi3.value = `🔄 POS Billed Sales: ${totalPos}`;
  kpi3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  kpi3.font = { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF0F172A' } };
  kpi3.alignment = { vertical: 'middle', horizontal: 'center' };
  kpi3.border = kpiBorder;

  ws.mergeCells('J4:N4');
  const kpi4 = ws.getCell('J4');
  let reconcilText = '✓ Matches POS & Stock';
  let reconcilBg = 'FFECFDF5';
  let reconcilColor = 'FF065F46';
  if (surplusBtls > 0 && shortageBtls > 0) {
    reconcilText = `⚠️ +${surplusBtls} Surplus | 🔻 -${shortageBtls} Shortage | Sales diff: ${totalSold - totalPos}`;
    reconcilBg = 'FFFEF3C7';
    reconcilColor = 'FF92400E';
  } else if (surplusBtls > 0) {
    reconcilText = `⚠️ +${surplusBtls} Surplus (${surplusLines.length} item) | Sales diff: ${totalSold - totalPos}`;
    reconcilBg = 'FFFEF3C7';
    reconcilColor = 'FF92400E';
  } else if (shortageBtls > 0) {
    reconcilText = `🔻 -${shortageBtls} Shortage (${shortageLines.length} item) | Sales diff: ${totalSold - totalPos}`;
    reconcilBg = 'FFFEE2E2';
    reconcilColor = 'FF991B1B';
  } else if (totalSold !== totalPos) {
    reconcilText = `Sales diff: ${totalSold > totalPos ? '+' : ''}${totalSold - totalPos} bottles`;
    reconcilBg = 'FFFEF3C7';
    reconcilColor = 'FF92400E';
  }
  kpi4.value = reconcilText;
  kpi4.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: reconcilBg } };
  kpi4.font = { name: 'Calibri', bold: true, size: 10, color: { argb: reconcilColor } };
  kpi4.alignment = { vertical: 'middle', horizontal: 'center' };
  kpi4.border = kpiBorder;
  ws.getRow(4).height = 24;

  // 5. Spacing
  ws.getRow(5).height = 8;

  // 6. Header Row (Row 6)
  const headers = [
    '#',
    'Product Name',
    'Pack Qty',
    'Opening (Btls)',
    'Inward (Btls)',
    'Available (Btls)',
    'POS Sold (Btls)',
    'Closing Count',
    'Closing Cases',
    'Closing Loose',
    'Counter Sold',
    'Status / Discrepancy',
    'Rate (MRP ₹)',
    'Revenue (₹)',
  ];

  const headerRow = ws.getRow(6);
  headerRow.values = headers;
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'medium', color: { argb: 'FF0F172A' } },
      bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
      left: { style: 'thin', color: { argb: 'FF3B82F6' } },
      right: { style: 'thin', color: { argb: 'FF3B82F6' } },
    };
  });

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };

  // 7. Data Rows
  let rowIdx = 7;
  for (let i = 0; i < sheet.lines.length; i++) {
    const l = sheet.lines[i];
    const available = l.openingBottles + l.inwardBottles;
    const posSold = l.posSoldBottles ?? 0;
    const expectedClosing = Math.max(0, available - posSold);

    const isSurplus = l.closingBottles > available;
    const isShortage = posSold > 0 && l.closingBottles < expectedClosing;
    const isExcess = posSold > 0 && l.closingBottles > expectedClosing;

    let status = '✓ Matched POS';
    let rowBg = (i % 2 === 0) ? 'FFFFFFFF' : 'FFF8FAFC';

    if (isSurplus) {
      status = `⚠️ Surplus (+${l.closingBottles - available} btls)`;
      rowBg = 'FFFEF3C7';
    } else if (isShortage) {
      status = `🔻 Below Stock (-${expectedClosing - l.closingBottles} btls)`;
      rowBg = 'FFFEE2E2';
    } else if (isExcess) {
      status = `📦 Shelf Excess (+${l.closingBottles - expectedClosing} vs POS)`;
      rowBg = 'FFE0F2FE';
    }

    const r = ws.getRow(rowIdx);
    r.values = [
      i + 1,
      l.productName,
      l.packQuantity ?? 1,
      l.openingBottles,
      l.inwardBottles,
      available,
      posSold,
      l.closingBottles,
      l.closingSplit?.cases ?? '',
      l.closingSplit?.loose ?? '',
      l.soldBottles,
      status,
      parseFloat(l.sellingRate),
      parseFloat(l.lineRevenue),
    ];
    r.height = 22;

    r.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = thinBorder;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
      cell.font = { name: 'Calibri', size: 10 };

      if (colNumber === 1 || colNumber === 3) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (colNumber === 2) {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
        cell.font = { name: 'Calibri', size: 10, bold: true };
      } else if (colNumber >= 4 && colNumber <= 11) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.numFmt = '#,##0';
        if (colNumber === 8 || colNumber === 11) cell.font = { name: 'Calibri', size: 10, bold: true };
      } else if (colNumber === 12) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (isSurplus) cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF92400E' } };
        else if (isShortage) cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF991B1B' } };
        else if (isExcess) cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF075985' } };
        else cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF065F46' } };
      } else if (colNumber === 13 || colNumber === 14) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.numFmt = '₹#,##0.00';
        if (colNumber === 14) cell.font = { name: 'Calibri', size: 10, bold: true };
      }
    });

    rowIdx++;
  }

  // 8. Total Summary Footer Row
  const totalRow = ws.getRow(rowIdx);
  const startData = 7;
  const endData = rowIdx - 1;
  totalRow.values = [
    '',
    'TOTAL',
    '',
    { formula: `SUM(D${startData}:D${endData})` },
    { formula: `SUM(E${startData}:E${endData})` },
    { formula: `SUM(F${startData}:F${endData})` },
    { formula: `SUM(G${startData}:G${endData})` },
    { formula: `SUM(H${startData}:H${endData})` },
    '',
    '',
    { formula: `SUM(K${startData}:K${endData})` },
    '',
    '',
    { formula: `SUM(N${startData}:N${endData})` },
  ];
  totalRow.height = 24;

  const totalBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FF1E293B' } },
    bottom: { style: 'double', color: { argb: 'FF1E293B' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };

  totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = { name: 'Calibri', size: 11, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.border = totalBorder;
    if (colNumber >= 4 && colNumber <= 11) {
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.numFmt = '#,##0';
    } else if (colNumber === 14) {
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.numFmt = '₹#,##0.00';
    } else if (colNumber === 2) {
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
    }
  });

  // Enable AutoFilter on Table Header
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: 14 } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function getSheetExcel(id: string): Promise<{ buffer: Buffer; filename: string }> {
  const sheet = await getSheet(id);
  const [branch] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, sheet.branchId)).limit(1);
  const buffer = await sheetToExcel(sheet, branch?.name);
  const filename = `counter-sheet-${sheet.sheetDate}.xlsx`;
  return { buffer, filename };
}

export async function getBranchSheetExcel(branchId: string, date?: string): Promise<{ buffer: Buffer; filename: string }> {
  const sheets = await listSheets(branchId, date);
  if (sheets.length === 0) {
    throw new NotFoundError(date ? `No counter sheet found for date ${date}` : 'No counter sheets found for this branch');
  }
  const sheet = await getSheet(sheets[0].id);
  const [branch] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, branchId)).limit(1);
  const buffer = await sheetToExcel(sheet, branch?.name);
  const filename = `counter-sheet-${sheet.sheetDate}.xlsx`;
  return { buffer, filename };
}
