import Papa from 'papaparse';
import ExcelJS from 'exceljs';

export const MAX_ROWS = 5000;
export const MAX_COLS = 60;

function clip(rows: string[][]): string[][] {
  return rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((c) => (c ?? '').toString().trim()));
}

/** CSV / TSV text → rows of cells. Delimiter auto-detected (comma, semicolon, tab, pipe). */
export function parseCsvRows(text: string): string[][] {
  const res = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    delimitersToGuess: [',', '\t', ';', '|'],
  });
  return clip(res.data.filter((r) => Array.isArray(r)));
}

/** Converts an exceljs cell value (formula result, rich text, hyperlink, date, …) to text. */
export function excelValueToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return excelValueToString((o.result ?? null) as ExcelJS.CellValue);   // formula → cached result
    if ('formula' in o || 'sharedFormula' in o) return '';
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
    if ('text' in o) return excelValueToString((o.text ?? null) as ExcelJS.CellValue);         // hyperlink
    if ('error' in o) return '';
  }
  return String(v);
}

/** XLSX → rows of the first non-empty worksheet. */
export async function parseXlsxRows(buf: Buffer): Promise<{ rows: string[][]; sheetName: string | null }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      const cells: string[] = [];
      const count = Math.min(row.cellCount, MAX_COLS);
      for (let c = 1; c <= count; c++) cells.push(excelValueToString(row.getCell(c).value).trim());
      if (cells.some((c) => c !== '')) rows.push(cells);
    });
    if (rows.length > 0) return { rows: clip(rows), sheetName: ws.name };
  }
  return { rows: [], sheetName: null };
}
