import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { extractInvoice } from '../../src/modules/invoices/extraction/index.js';
import { TELANGANA_ICDC_PRODUCTS } from '../../src/db/data/telangana-products.js';
import { supplierInvoicesDir, telanganaCatalogCsv } from '../fixtures/paths.mjs';

const SAFE = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[<>]/.test(s), 'Must not contain < or >');
const Row = z.object({
  state: z.string().trim().min(2).max(4).toUpperCase().default('TS'),
  categoryName: SAFE(60),
  name: SAFE(200),
  brand: SAFE(120),
  volumeMl: z.coerce.number().int().min(1).max(20000),
  packQuantity: z.coerce.number().int().min(1).max(1000),
  exciseCode: SAFE(10),
  sku: SAFE(64),
});

function cleanQuotes(str: string): string {
  return str.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

async function main() {
  const dir = supplierInvoicesDir;
  const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));

  const map = new Map<string, {
    exciseCode: string;
    volumeMl: number;
    packQuantity: number;
    rawNames: Set<string>;
    files: Set<string>;
  }>();

  for (const f of files) {
    const buf = readFileSync(join(dir, f));
    const inv = await extractInvoice(buf);
    for (const l of inv.table.lines) {
      if (l.sku && l.volumeMl) {
        const key = `${l.sku}:${l.volumeMl}`;
        if (!map.has(key)) {
          map.set(key, {
            exciseCode: l.sku,
            volumeMl: l.volumeMl,
            packQuantity: l.packQuantity || 0,
            rawNames: new Set(),
            files: new Set(),
          });
        }
        const r = map.get(key)!;
        if (l.packQuantity) r.packQuantity = l.packQuantity;
        r.rawNames.add(l.description);
        r.files.add(f);
      }
    }
  }

  const cleanedRows: Array<{
    categoryName: string;
    name: string;
    brand: string;
    volumeMl: number;
    packQuantity: number;
    exciseCode: string;
    sku: string;
    state: string;
  }> = [];

  for (const [key, item] of map.entries()) {
    const matched = TELANGANA_ICDC_PRODUCTS.find(
      p => p.exciseCode === item.exciseCode && p.volumeMl === item.volumeMl
    );

    let category = matched?.category;
    let brand = matched?.brand;
    let name = matched?.name;
    let packQuantity = item.packQuantity || matched?.packQuantity || 12;
    let sku = matched?.sku;

    if (!category || !brand || !name || !sku) {
      const raw = Array.from(item.rawNames)[0] || '';
      category = 'Whisky';
      const u = raw.toUpperCase();
      if (u.includes('BEER') || u.includes('LAGER')) category = 'Beer';
      else if (u.includes('VODKA')) category = 'Vodka';
      else if (u.includes('RUM')) category = 'Rum';
      else if (u.includes('BRANDY')) category = 'Brandy';
      else if (u.includes('GIN')) category = 'Gin';
      else if (u.includes('WINE')) category = 'Wine';

      brand = raw;
      name = `${raw} ${item.volumeMl}ml`;
      sku = `TS-${item.exciseCode}-${item.volumeMl}`;
    }

    // Fix Absolut Raspberri category if miscategorized as Whisky
    if (brand.toLowerCase().includes('absolut') || name.toLowerCase().includes('absolut')) {
      category = 'Vodka';
    }

    // Clean backticks
    brand = cleanQuotes(brand);
    name = cleanQuotes(name);

    // Fix name volume suffix
    const volSuffixMatch = name.match(/(\d+)\s*ml$/i);
    if (volSuffixMatch && parseInt(volSuffixMatch[1], 10) !== item.volumeMl) {
      name = name.replace(/\d+\s*ml$/i, `${item.volumeMl}ml`);
    } else if (!volSuffixMatch) {
      name = `${name} ${item.volumeMl}ml`;
    }

    const rowObj = {
      categoryName: category,
      name: name.trim(),
      brand: brand.trim(),
      volumeMl: item.volumeMl,
      packQuantity,
      exciseCode: item.exciseCode,
      sku: sku.trim(),
      state: 'TS',
    };

    const parsed = Row.safeParse(rowObj);
    if (!parsed.success) {
      console.error(`Validation failed for ${key}:`, parsed.error);
    } else {
      cleanedRows.push(parsed.data);
    }
  }

  // Sort by categoryName, brand, volumeMl
  cleanedRows.sort((a, b) =>
    a.categoryName.localeCompare(b.categoryName) ||
    a.brand.localeCompare(b.brand) ||
    a.volumeMl - b.volumeMl
  );

  const csvOutput = cleanedRows.map(r =>
    `${r.categoryName},${r.name},${r.brand},${r.volumeMl},${r.packQuantity},${r.exciseCode},${r.sku},${r.state}`
  ).join('\n');

  writeFileSync(telanganaCatalogCsv, csvOutput, 'utf-8');
  console.log(`Generated ${cleanedRows.length} clean master product entries.`);
}

main().catch(console.error);
