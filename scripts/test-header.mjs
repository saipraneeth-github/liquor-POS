import fs from 'node:fs';
import { extractPdfText } from '../src/modules/invoices/extraction/pdf-text.js';
import { textLinesToRows, parseHeaderLine } from '../src/modules/invoices/extraction/text-lines.engine.js';

async function test(name) {
  const buf = fs.readFileSync('testing_invoices/' + name);
  const pdf = await extractPdfText(buf);
  const clean = pdf.lines.map(l => l.text).filter(l => l.trim());
  for (let i = 0; i < Math.min(clean.length, 25); i++) {
    const f = parseHeaderLine(clean[i]);
    console.log(`Line ${i}: "${clean[i]}" => fields: [${f.join(', ')}]`);
  }
  const res = textLinesToRows(clean);
  console.log(`\nResult headerFound: ${res.headerFound}, headerLineIndex: ${res.headerLineIndex}`);
  console.log('Synthesized header:', res.rows[0]);
  console.log('Row 1:', res.rows[1]);
  console.log('Row 2:', res.rows[2]);
}

test(process.argv[2] || 'ICDC.pdf').catch(console.error);

