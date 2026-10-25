import { UnsupportedFileError, type SourceKind } from './types.js';

export interface DetectedType {
  kind: SourceKind;
  mimeType: string;
  /** For IMAGE: 'png' | 'jpeg' */
  subtype?: 'png' | 'jpeg' | 'csv' | 'xlsx' | 'pdf';
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identifies the upload by its magic bytes / content — never by the file name or the client's content type.
 * Throws UnsupportedFileError (→ 415) for anything else (old .xls, .docx, zip, binaries, …).
 */
export function detectFileType(buf: Buffer): DetectedType {
  if (buf.length === 0) throw new UnsupportedFileError('The uploaded file is empty');

  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'PDF', mimeType: 'application/pdf', subtype: 'pdf' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return { kind: 'IMAGE', mimeType: 'image/png', subtype: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'IMAGE', mimeType: 'image/jpeg', subtype: 'jpeg' };

  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // OOXML zip: entry names are stored uncompressed in the local/central headers
    if (buf.includes('xl/workbook.xml', 0, 'latin1') || buf.includes('xl/worksheets/', 0, 'latin1')) {
      return { kind: 'EXCEL', mimeType: XLSX_MIME, subtype: 'xlsx' };
    }
    throw new UnsupportedFileError('ZIP/Office file is not an Excel workbook (.xlsx)');
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new UnsupportedFileError('Old Excel (.xls) files are not supported — save the sheet as .xlsx or .csv');
  }

  if (isUtf8Text(buf)) return { kind: 'CSV', mimeType: 'text/csv', subtype: 'csv' };

  throw new UnsupportedFileError();
}

/** Valid UTF-8, no NUL bytes and (almost) no control characters other than tab / CR / LF. */
export function isUtf8Text(buf: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  if (text.includes('\u0000')) return false;
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control <= Math.max(2, text.length * 0.001) && /[A-Za-z0-9]/.test(text);
}

/** Decodes a UTF-8 text upload, stripping a BOM. */
export function decodeText(buf: Buffer): string {
  return new TextDecoder('utf-8').decode(buf);  // TextDecoder drops a UTF-8 BOM by default
}

/** Reads pixel dimensions from PNG / JPEG headers without decoding (guards against decompression bombs). */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
