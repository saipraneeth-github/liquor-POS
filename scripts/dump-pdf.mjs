import fs from 'node:fs';
import { extractPdfText } from '../src/modules/invoices/extraction/pdf-text.js';

async function dump(name) {
  const buf = fs.readFileSync('testing_invoices/' + name);
  const res = await extractPdfText(buf);
  console.log(`=== ${name} === (lines count: ${res.lines.length})`);
  for (let i = 0; i < res.lines.length; i++) {
    console.log(`[${i}]: ${res.lines[i].text}`);
  }
}

const file = process.argv[2] || 'ICDC.pdf';
dump(file).catch(console.error);
