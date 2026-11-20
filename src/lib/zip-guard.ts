/**
 * Refuses a zip (an .xlsx is one) whose declared uncompressed size is far beyond what a spreadsheet of the allowed upload
 * size could hold. The upload cap counts compressed bytes only; a "zip bomb" a few KB long inflates to gigabytes when a
 * library loads it and can crash the single Node process. Only the central directory is read: nothing is inflated here.
 */
export class ZipTooLargeError extends Error {}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export function assertZipSafe(buf: Buffer, opts: { maxTotalBytes?: number; maxEntries?: number; maxEntryBytes?: number } = {}): void {
  const maxTotal = opts.maxTotalBytes ?? 200 * 1024 * 1024;
  const maxEntries = opts.maxEntries ?? 2000;
  const maxEntry = opts.maxEntryBytes ?? 100 * 1024 * 1024;

  // End-of-central-directory record: 22 bytes, followed by an optional comment of up to 65535 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return;   // not a zip we can inspect: the real parser will reject it
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new ZipTooLargeError(`The spreadsheet has too many parts (${count}).`);

  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
    const uncompressed = buf.readUInt32LE(offset + 24);
    if (uncompressed > maxEntry) throw new ZipTooLargeError('The spreadsheet contains a part that is far too large to be a normal file.');
    total += uncompressed;
    if (total > maxTotal) throw new ZipTooLargeError('The spreadsheet would expand to far more data than a normal file of this size.');
    offset += 46 + buf.readUInt16LE(offset + 28) + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
}
