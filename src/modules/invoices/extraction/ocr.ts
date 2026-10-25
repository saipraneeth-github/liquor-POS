/**
 * ocr.ts — offline OCR with tesseract.js using the bundled @tesseract.js-data/eng model (never a CDN).
 *
 * One lazily-created worker, one job at a time (concurrency 1), a per-page timeout (the worker is killed and
 * recreated on timeout) and terminateOcr() for app shutdown. Settings come from the spike: 4.0.0 model,
 * 2x upscale for small images, page-seg mode 6 (uniform block), preserved inter-word spaces.
 */
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Worker } from 'tesseract.js';
import { imageDimensions } from './detect-type.js';
import { NothingExtractableError } from './types.js';

export const OCR_PAGE_TIMEOUT_MS = Number(process.env.OCR_PAGE_TIMEOUT_MS ?? 30_000);
export const OCR_MAX_PAGES = 10;
const MAX_PIXELS = 40_000_000;          // decompression-bomb guard (source image)
const UPSCALE_BELOW_WIDTH = 2000;
const MAX_OCR_WIDTH = 5000;

export interface OcrLine { text: string; confidence: number }
export interface OcrResult { text: string; confidence: number; lines: OcrLine[] }

const require = createRequire(import.meta.url);

function langPath(): string {
  return path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');
}

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Loaded lazily so the API starts even where OCR is never used
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng', 1, {
        langPath: langPath(),
        gzip: true,
        cachePath: path.join(os.tmpdir(), 'liquor-pos-tesseract'),
      });
      await w.setParameters({ tessedit_pageseg_mode: '6' as never, preserve_interword_spaces: '1' });
      return w;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** Terminates the OCR worker (fastify onClose). Safe to call when no worker exists. */
export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try { await (await p).terminate(); } catch { /* already gone */ }
}

/** Runs `fn` after every previously queued OCR job (concurrency 1). */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Upscales small images 2x (OCR accuracy) and re-encodes as PNG. Rejects oversized images. */
export async function prepareImage(buf: Buffer): Promise<Buffer> {
  const dims = imageDimensions(buf);
  if (!dims || dims.width === 0 || dims.height === 0) throw new NothingExtractableError('Could not read the image dimensions — is the image corrupt?');
  if (dims.width * dims.height > MAX_PIXELS) throw new NothingExtractableError('Image is too large to OCR (max 40 megapixels) — upload a smaller scan');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(buf);
  let scale = img.width < UPSCALE_BELOW_WIDTH ? 2 : 1;
  if (img.width * scale > MAX_OCR_WIDTH) scale = MAX_OCR_WIDTH / img.width;
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}

/** OCRs one prepared PNG page. Times out after OCR_PAGE_TIMEOUT_MS (worker is then recreated). */
export function ocrPng(png: Buffer, timeoutMs = OCR_PAGE_TIMEOUT_MS): Promise<OcrResult> {
  return serialize(async () => {
    const worker = await getWorker();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NothingExtractableError(`OCR timed out after ${Math.round(timeoutMs / 1000)}s — try a clearer or smaller image`)), timeoutMs);
    });
    try {
      const { data } = await Promise.race([worker.recognize(png, {}, { text: true, blocks: true }), timeout]);
      const lines: OcrLine[] = [];
      for (const b of data.blocks ?? []) {
        for (const p of b.paragraphs ?? []) {
          for (const l of p.lines ?? []) {
            const text = l.text.replace(/\s+$/, '');
            if (text.trim()) lines.push({ text, confidence: l.confidence });
          }
        }
      }
      if (lines.length === 0) {
        for (const t of (data.text ?? '').split(/\r?\n/)) if (t.trim()) lines.push({ text: t, confidence: data.confidence });
      }
      return { text: data.text ?? '', confidence: data.confidence ?? 0, lines };
    } catch (err) {
      if (err instanceof NothingExtractableError) await terminateOcr();   // stuck worker: start fresh next time
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

/** Image upload (PNG/JPEG) → OCR result. */
export async function ocrImage(buf: Buffer): Promise<OcrResult> {
  return ocrPng(await prepareImage(buf));
}
