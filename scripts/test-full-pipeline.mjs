import fs from 'node:fs';
import { extractInvoice } from '../src/modules/invoices/extraction/index.js';
import { buildDraftLines } from '../src/modules/invoices/draft.engine.js';
import { loadCatalog } from '../src/modules/invoices/invoice.service.js';

async function run() {
  const catalog = await loadCatalog();
  console.log(`Loaded catalog with ${catalog.length} active products.`);
  
  const buf = fs.readFileSync('testing_invoices/ICDC.pdf');
  const extracted = await extractInvoice(buf);
  console.log('Extracted lines:', extracted.table.lines.length);
  const draftLines = buildDraftLines(extracted.table.lines, catalog);
  console.log('Draft lines summary:');
  for (const dl of draftLines.slice(0, 5)) {
    console.log({
      line: dl.lineNumber,
      desc: dl.rawDescription,
      productName: dl.productName,
      status: dl.matchStatus,
      qty: dl.quantity,
      cost: dl.costPrice,
      mrp: dl.mrp,
      lineTotal: dl.lineCostTotal,
      flags: dl.flags
    });
  }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });

