/**
 * pdf-text.ts — PDF → text lines. Uses the text layer (exact, x/y positioned) and falls back to OCR for
 * pages with (almost) no text, i.e. scans: the page is rendered at 2x with @napi-rs/canvas and OCR'd.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { ocrPng, OCR_MAX_PAGES, type OcrLine } from './ocr.js';
import { NothingExtractableError, type PagePositionedItem } from './types.js';

const MAX_PDF_PAGES = 20;
const MIN_TEXT_CHARS_PER_PAGE = 20;
const RENDER_SCALE = 2;
const MAX_RENDER_PIXELS = 24_000_000;   // an A4 page at 2x is about 2 million: anything near this is not an invoice
const MAX_ITEMS_PER_PAGE = 50_000;      // text pieces kept per page: a page of millions of tiny strings is an attack, not an invoice

/**
 * PURE: the scale to render a page at. The page size is declared by the file itself, so a page "20 000 x 20 000 points"
 * would otherwise ask for a canvas of gigabytes. The scale is reduced until the canvas stays within `maxPixels`.
 */
export function renderScaleFor(pageWidth: number, pageHeight: number, baseScale = RENDER_SCALE, maxPixels = MAX_RENDER_PIXELS): number {
  const px = pageWidth * pageHeight * baseScale * baseScale;
  if (!Number.isFinite(px) || px <= maxPixels) return baseScale;
  return Math.max(0.1, baseScale * Math.sqrt(maxPixels / px));
}

export interface PositionedItem { str: string; x: number; y: number; width: number; size: number }

export interface PdfTextResult {
  lines: OcrLine[];          // confidence 100 for text-layer lines
  pages: number;
  ocrPages: number;
  ocrConfidence: number | null;
  truncated: boolean;
  items?: PagePositionedItem[];
}

const require = createRequire(import.meta.url);
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function standardFontDataUrl(): string {
  // pdfjs in Node reads this with fs; it insists on a trailing forward slash (also on Windows)
  return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';
}

/**
 * PURE: groups positioned text items into lines by y (tolerance ~40% of font size), sorted top→bottom,
 * and joins items left→right; a horizontal gap wider than ~0.8em becomes a double space (column break).
 */
export function itemsToLines(items: PositionedItem[]): string[] {
  const visible = items.filter((i) => i.str.trim() !== '');
  const rows: PositionedItem[][] = [];
  for (const it of [...visible].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= Math.max(2, r[0].size * 0.4));
    if (row) row.push(it); else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let out = '';
    let prevEnd: number | null = null;
    for (const it of row) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        out += gap > it.size * 0.8 ? '  ' : gap > it.size * 0.1 ? ' ' : '';
      }
      out += it.str;
      prevEnd = it.x + it.width;
    }
    return out.trimEnd();
  });
}

export async function extractPdfText(buf: Buffer): Promise<PdfTextResult> {
  const pdfjs = await loadPdfjs();
  // Copy: pdfjs transfers/detaches the buffer it is given
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    throw new NothingExtractableError(/password/i.test(msg) ? 'The PDF is password protected' : 'The PDF could not be read (corrupt or unsupported)');
  }

  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const lines: OcrLine[] = [];
  const allPositionedItems: PagePositionedItem[] = [];
  let ocrPages = 0;
  let confSum = 0;
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items: PositionedItem[] = [];
      for (const it of tc.items) {
        if (items.length >= MAX_ITEMS_PER_PAGE) break;
        if (!('str' in it)) continue;
        const size = Math.hypot(it.transform[0], it.transform[1]) || it.height || 10;
        const item = { str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, size };
        items.push(item);
        if (it.str.trim()) {
          allPositionedItems.push({ page: p, ...item });
        }
      }
      const chars = items.reduce((n, i) => n + i.str.trim().length, 0);
      if (chars >= MIN_TEXT_CHARS_PER_PAGE) {
        for (const text of itemsToLines(items)) if (text.trim()) lines.push({ text, confidence: 100 });
        continue;
      }
      // Scanned page → render and OCR (bounded)
      if (ocrPages >= OCR_MAX_PAGES) continue;
      const { createCanvas } = await import('@napi-rs/canvas');
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: renderScaleFor(natural.width, natural.height) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as never, viewport, canvas: canvas as never }).promise;
      const ocr = await ocrPng(canvas.toBuffer('image/png'));
      ocrPages++;
      confSum += ocr.confidence;
      lines.push(...ocr.lines);
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
  return {
    lines,
    pages,
    ocrPages,
    ocrConfidence: ocrPages > 0 ? Math.round(confSum / ocrPages) : null,
    truncated: doc.numPages > pages,
    items: allPositionedItems,
  };
}
