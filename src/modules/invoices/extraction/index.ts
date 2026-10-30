/**
 * Extraction orchestrator: bytes → { header, lines, total, warnings, meta }.
 * Type is sniffed from content; CSV/XLSX go straight to the table engine, PDF text and OCR output go through
 * the text-line engine first (or the dedicated Telangana ICDC engine for excise challans). Nothing here touches the database.
 */
import { detectFileType, decodeText } from './detect-type.js';
import { parseCsvRows, parseXlsxRows } from './tabular.js';
import { rowsToLines } from './table.engine.js';
import { textLinesToRows } from './text-lines.engine.js';
import { extractHeaderFields } from './header-fields.engine.js';
import { extractPdfText } from './pdf-text.js';
import { ocrImage, type OcrLine } from './ocr.js';
import { isIcdcDocument, extractIcdcDocument } from './icdc.engine.js';
import {
  NothingExtractableError,
  type ColumnMapping,
  type ExtractedHeader,
  type ExtractionResult,
  type ExtractionMeta,
  type TableResult,
} from './types.js';

export * from './types.js';
export { detectFileType, findPdfOffset } from './detect-type.js';
export { terminateOcr } from './ocr.js';
export {
  isIcdcDocument,
  extractIcdcDocument,
  extractIcdcHeader,
  extractIcdcTable,
  extractIcdcTotals,
} from './icdc.engine.js';

export interface ExtractOptions {
  columnMapping?: ColumnMapping;
}

/** Text lines (PDF / OCR) → table result, attaching per-line OCR confidence by matching line text. */
function tableFromTextLines(lines: OcrLine[], mapping?: ColumnMapping): { table: TableResult; headerText: string[]; tableStart: number } {
  lines = lines.filter((l) => l.text.trim());
  const { rows, headerLineIndex } = textLinesToRows(lines.map((l) => l.text));
  const table = rowsToLines(rows, mapping);
  // Re-attach confidence: each item line's description came from exactly one source line
  const remaining = [...lines];
  for (const line of table.lines) {
    const idx = remaining.findIndex((l) => l.text.includes(line.description));
    if (idx >= 0) {
      line.confidence = Math.round(remaining[idx].confidence);
      remaining.splice(idx, 1);
    }
  }
  return { table, headerText: lines.map((l) => l.text), tableStart: headerLineIndex >= 0 ? headerLineIndex : 0 };
}

function rowsAsText(rows: string[][]): string[] {
  return rows.map((r) => r.filter((c) => c).join('  '));
}

export async function extractInvoice(buf: Buffer, opts: ExtractOptions = {}): Promise<ExtractionResult> {
  const started = Date.now();
  const detected = detectFileType(buf);
  if (detected.kind === 'PDF' && detected.offset && detected.offset > 0) {
    buf = buf.subarray(detected.offset);
  }

  const warnings: string[] = [];
  let table: TableResult;
  let header: ExtractedHeader | null = null;
  let headerText: string[];
  let tableStart = 0;
  const meta: Partial<ExtractionMeta> = {};

  switch (detected.kind) {
    case 'CSV': {
      const rows = parseCsvRows(decodeText(buf));
      table = rowsToLines(rows, opts.columnMapping);
      headerText = rowsAsText(rows);
      tableStart = Math.max(0, table.headerRowIndex ?? 0);
      meta.engine = 'papaparse';
      meta.rowCount = rows.length;
      break;
    }
    case 'EXCEL': {
      let parsed;
      try {
        parsed = await parseXlsxRows(buf);
      } catch {
        throw new NothingExtractableError('The Excel workbook could not be read — re-save it as .xlsx or export to CSV');
      }
      table = rowsToLines(parsed.rows, opts.columnMapping);
      headerText = rowsAsText(parsed.rows);
      tableStart = Math.max(0, table.headerRowIndex ?? 0);
      meta.engine = 'exceljs';
      meta.sheetName = parsed.sheetName ?? undefined;
      meta.rowCount = parsed.rows.length;
      break;
    }
    case 'PDF': {
      const pdf = await extractPdfText(buf);
      const isIcdc = Boolean(pdf.items && isIcdcDocument(pdf.lines.map((l) => l.text)));
      if (isIcdc && pdf.items) {
        const icdc = extractIcdcDocument(pdf.items, pdf.lines.map((l) => l.text));
        table = icdc.table;
        headerText = icdc.headerText;
        header = icdc.header;
        tableStart = 0;
        meta.engine = 'icdc-extractor';
        if (icdc.specialCess) meta.specialCess = icdc.specialCess;
      } else {
        ({ table, headerText, tableStart } = tableFromTextLines(pdf.lines, opts.columnMapping));
        meta.engine = pdf.ocrPages > 0 ? (pdf.ocrPages < pdf.pages ? 'pdfjs+tesseract' : 'tesseract(pdf)') : 'pdfjs';
      }
      meta.pages = pdf.pages;
      meta.ocrPages = pdf.ocrPages;
      if (pdf.ocrConfidence !== null) meta.ocrConfidence = pdf.ocrConfidence;
      if (pdf.truncated) warnings.push('PDF_PAGES_TRUNCATED');
      if (pdf.ocrPages > 0) warnings.push('OCR_USED');
      break;
    }
    case 'IMAGE': {
      const ocr = await ocrImage(buf);
      ({ table, headerText, tableStart } = tableFromTextLines(ocr.lines, opts.columnMapping));
      meta.engine = 'tesseract';
      meta.pages = 1;
      meta.ocrPages = 1;
      meta.ocrConfidence = Math.round(ocr.confidence);
      warnings.push('OCR_USED');
      break;
    }
  }

  if (table.lines.length === 0) {
    const hint = detected.kind === 'CSV' || detected.kind === 'EXCEL'
      ? 'No invoice lines found. The sheet needs a header row with at least Description/Item and two of Qty, Rate, MRP, Amount — or send a columnMapping.'
      : 'No invoice lines could be read from the document. Use a clearer scan/photo, a text PDF, or upload the CSV/Excel version.';
    throw new NothingExtractableError(hint);
  }

  header ??= extractHeaderFields(headerText, tableStart);
  if (table.totalUnreadable) warnings.push('TOTAL_UNREADABLE');
  else if (table.capturedTotal === null) warnings.push('TOTAL_NOT_FOUND');

  return {
    kind: detected.kind,
    mimeType: detected.mimeType,
    header,
    table,
    warnings,
    meta: {
      ...meta,
      engine: meta.engine ?? 'unknown',
      durationMs: Date.now() - started,
      headerRowIndex: table.headerRowIndex,
      columns: table.columns,
      gstin: header.gstin,
      capturedTotal: table.capturedTotal,
    },
  };
}
