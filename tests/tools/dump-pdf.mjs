import fs from 'node:fs';
import { join } from 'node:path';
import { extractPdfText } from '../../src/modules/invoices/extraction/pdf-text.js';
import { supplierInvoicesDir } from '../fixtures/paths.mjs';

async function dump(name) {
  const buf = fs.readFileSync(join(supplierInvoicesDir, name));
  const res = await extractPdfText(buf);
  console.log(`=== ${name} === (lines count: ${res.lines.length})`);
  for (let i = 0; i < res.lines.length; i++) {
    console.log(`[${i}]: ${res.lines[i].text}`);
  }
}

const file = process.argv[2] || 'ICDC.pdf';
dump(file).catch(console.error);
