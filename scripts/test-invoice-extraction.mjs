import fs from 'node:fs';
import path from 'node:path';
import { extractInvoice } from '../src/modules/invoices/extraction/index.js';

const dir = 'testing_invoices';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));

console.log(`Found ${files.length} PDF files in ${dir}`);

for (const file of files) {
  console.log(`\n==================================================`);
  console.log(`Processing: ${file}`);
  console.log(`==================================================`);
  try {
    const buf = fs.readFileSync(path.join(dir, file));
    const result = await extractInvoice(buf);
    console.log(`Status: SUCCESS`);
    console.log(`Kind: ${result.kind}, Engine: ${result.meta.engine}, Pages: ${result.meta.pages}, OCR Pages: ${result.meta.ocrPages}`);
    console.log(`Header:`, JSON.stringify(result.header, null, 2));
    console.log(`Captured Total: ${result.table.capturedTotal}`);
    console.log(`Warnings: ${result.warnings.join(', ') || 'none'}`);
    console.log(`Lines count: ${result.table.lines.length}`);
    for (let i = 0; i < Math.min(result.table.lines.length, 5); i++) {
      console.log(`  Line ${i + 1}:`, JSON.stringify(result.table.lines[i]));
    }
    if (result.table.lines.length > 5) {
      console.log(`  ... and ${result.table.lines.length - 5} more lines`);
    }
  } catch (err) {
    console.log(`Status: FAILED`);
    console.log(`Error: ${err.name} - ${err.message}`);
  }
}
process.exit(0);
