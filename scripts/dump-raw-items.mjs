import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

function standardFontDataUrl() {
  return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';
}

async function dumpItems(filename) {
  let buf = fs.readFileSync('testing_invoices/' + filename);
  const pdfIdx = buf.indexOf(Buffer.from('%PDF-'));
  if (pdfIdx > 0) buf = buf.subarray(pdfIdx);

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  }).promise;

  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  console.log(`=== ${filename} PAGE 1 ITEMS (Total: ${tc.items.length}) ===`);
  
  // Sort by y desc, then x asc
  const items = tc.items
    .filter(i => 'str' in i && i.str.trim())
    .map(i => ({ str: i.str, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]), w: Math.round(i.width) }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  // Group by rough y (within 3 points)
  let currentY = -9999;
  let line = [];
  for (const it of items) {
    if (Math.abs(it.y - currentY) > 3) {
      if (line.length) console.log(`y=${currentY.toString().padStart(4)}: ` + line.map(i => `[x=${i.x} w=${i.w}] "${i.str}"`).join(' '));
      currentY = it.y;
      line = [it];
    } else {
      line.push(it);
    }
  }
  if (line.length) console.log(`y=${currentY.toString().padStart(4)}: ` + line.map(i => `[x=${i.x} w=${i.w}] "${i.str}"`).join(' '));
}

const file = process.argv[2] || 'ICDC.pdf';
dumpItems(file).catch(console.error);
