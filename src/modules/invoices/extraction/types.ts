/**
 * Shared types for supplier-invoice extraction (CSV / XLSX / PDF / image → invoice lines).
 * Extraction output is NEVER trusted blindly: every invoice lands as a DRAFT with flags.
 */

export type SourceKind = 'CSV' | 'EXCEL' | 'PDF' | 'IMAGE';
export type InvoiceSource = 'MANUAL' | SourceKind;

/** Logical invoice columns the table engine understands. */
export type InvoiceField =
  | 'description'
  | 'quantity'
  | 'cases'
  | 'rate'
  | 'mrp'
  | 'amount'
  | 'barcode'
  | 'sku'
  | 'taxRate';

export const INVOICE_FIELDS: readonly InvoiceField[] = [
  'description', 'quantity', 'cases', 'rate', 'mrp', 'amount', 'barcode', 'sku', 'taxRate',
];

/** Explicit column mapping override: field → 0-based column index or header text. */
export type ColumnMapping = Partial<Record<InvoiceField, number | string>>;

/** One invoice line as read from the document, before catalog matching. */
export interface ExtractedLine {
  lineNumber: number;
  description: string;
  barcode: string | null;
  sku: string | null;
  /** Loose units (bottles). */
  quantity: number | null;
  /** Quantity expressed in cases (converted to bottles after matching, when the pack size is known). */
  cases: number | null;
  rate: string | null;
  mrp: string | null;
  amount: string | null;
  taxRate: string | null;
  /** OCR confidence for the line (0-100), when the text came from OCR. */
  confidence: number | null;
  /** Extraction-time flags, e.g. UNREADABLE_NUMBER. */
  flags: string[];
}

export interface ExtractedHeader {
  supplierName: string | null;
  invoiceNumber: string | null;
  /** ISO yyyy-mm-dd */
  invoiceDate: string | null;
  gstin: string | null;
}

export interface TableResult {
  lines: ExtractedLine[];
  /** Invoice total printed on the document (grand total preferred over sub-total). */
  capturedTotal: string | null;
  /** True when a total row was found but its amount could not be read. */
  totalUnreadable: boolean;
  headerRowIndex: number | null;
  columns: Partial<Record<InvoiceField, number>>;
}

export interface ExtractionMeta {
  engine: string;
  pages?: number;
  ocrPages?: number;
  /** Mean OCR confidence 0-100 */
  ocrConfidence?: number;
  durationMs: number;
  headerRowIndex?: number | null;
  columns?: Partial<Record<InvoiceField, number>>;
  sheetName?: string;
  gstin?: string | null;
  capturedTotal?: string | null;
  [key: string]: unknown;
}

export interface ExtractionResult {
  kind: SourceKind;
  mimeType: string;
  header: ExtractedHeader;
  table: TableResult;
  warnings: string[];
  meta: ExtractionMeta;
}

/** Thrown for files whose content type is not supported (→ 415). */
export class UnsupportedFileError extends Error {
  readonly statusCode = 415;
  constructor(message = 'Unsupported file type. Upload a CSV, XLSX, PDF, PNG or JPEG invoice.') {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

/** Thrown when nothing usable could be extracted from a supported file (→ 422; file is not stored). */
export class NothingExtractableError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = 'NothingExtractableError';
  }
}
