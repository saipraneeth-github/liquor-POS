import fs from 'node:fs';
import { extractPdfText } from '../src/modules/invoices/extraction/pdf-text.js';

const dir = 'testing_invoices';
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.pdf'))) {
  let buf = fs.readFileSync(dir + '/' + f);
  // trim leading whitespace/newlines if needed to test
  const pdfIdx = buf.indexOf(Buffer.from('%PDF-'));
  if (pdfIdx > 0 && pdfIdx < 1024) {
    console.log(`${f}: HAS LEADING BYTES (${pdfIdx} bytes)`);
    buf = buf.subarray(pdfIdx);
  }
  try {
    const res = await extractPdfText(buf);
    console.log(`\n=== ${f} === (Pages: ${res.pages}, Lines: ${res.lines.length})`);
    console.log(res.lines.slice(0, 8).map(l => l.text).join('\n'));
  } catch (e) {
    console.log(`=== ${f} === ERROR: ${e.message}`);
  }
}

