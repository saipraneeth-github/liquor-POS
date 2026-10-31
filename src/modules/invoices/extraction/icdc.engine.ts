/**
 * icdc.engine.ts — PURE: specialized Telangana Excise ICDC invoice extraction.
 * Handles official Telangana State Prohibition & Excise Department Invoice Cum Delivery Challan (ICDC)
 * documents, accurately resolving multi-line brand names across line/page wraps, dual quantities (cases + bottles),
 * excise code (SKU) extraction, per-bottle unit rates, and Net Invoice Value totals.
 */
import { parseMoney } from './numbers.js';
import { parseDateText } from './header-fields.engine.js';
import type {
  ExtractedHeader,
  ExtractedLine,
  PagePositionedItem,
  TableResult,
} from './types.js';

export interface IcdcDocumentResult {
  table: TableResult;
  header: ExtractedHeader;
  headerText: string[];
  specialCess: string | null;
}

const ICDC_INDICATORS = [
  /INVOICE\s+CUM\s+DELIVERY\s+CHALLAN/i,
  /IM(?:F)?L\s+DEPOT/i,
  /ICDC\s*Number|\bICDC\d{10,25}\b/i,
  /PROHIBITION\s*&\s*EXCISE/i,
  /GOVERNMENT\s+OF\s+TELANGANA/i,
];

/**
 * Returns true if the text matches Telangana Excise ICDC document indicators.
 */
export function isIcdcDocument(textLines: string[]): boolean {
  const text = textLines.join('\n');
  return ICDC_INDICATORS.filter((re) => re.test(text)).length >= 2;
}

/**
 * Extracts invoice number, date, depot name, and excise TIN/GSTIN from ICDC positioned items and text lines.
 */
export function extractIcdcHeader(items: PagePositionedItem[], lines: string[]): ExtractedHeader {
  // 1. Invoice Number: e.g. ICDC037200326032761
  let invoiceNumber: string | null = null;
  for (const it of items) {
    const m = it.str.match(/\b(ICDC\d{10,25})\b/i);
    if (m) {
      invoiceNumber = m[1].toUpperCase();
      break;
    }
  }
  if (!invoiceNumber) {
    for (const l of lines) {
      const m = l.match(/\b(ICDC\d{10,25})\b/i) || l.match(/ICDC\s*Number\s*[:#\-]?\s*([A-Z0-9]+)/i);
      if (m) {
        invoiceNumber = m[1].toUpperCase();
        break;
      }
    }
  }

  // 2. Invoice Date: e.g. 20-Mar-2026, 07-Sep-2026
  let invoiceDate: string | null = null;
  const dateLabel = items.find((i) => /Invoice\s*Date/i.test(i.str));
  if (dateLabel) {
    const nearbyDate = items.find(
      (i) => i.page === dateLabel.page && Math.abs(i.y - dateLabel.y) <= 8 && parseDateText(i.str),
    );
    if (nearbyDate) invoiceDate = parseDateText(nearbyDate.str);
  }
  if (!invoiceDate) {
    for (const l of lines) {
      if (/Invoice\s*Date|Date\s*:/i.test(l)) {
        const d = parseDateText(l);
        if (d) {
          invoiceDate = d;
          break;
        }
      }
    }
  }
  if (!invoiceDate) {
    for (const it of items) {
      if (it.y > 450 && it.page === 1) {
        const d = parseDateText(it.str);
        if (d) {
          invoiceDate = d;
          break;
        }
      }
    }
  }

  // 3. Supplier Name (Excise Depot): e.g. "IMFL Depot Ranga Reddy-II", "IMFL Depot Medchal-II"
  let supplierName: string | null = null;
  for (const it of items) {
    const m = it.str.match(/IM(?:F)?L\s*DEPOT\s*:\s*([^(\n\r]+)/i);
    if (m) {
      supplierName = m[1].trim();
      break;
    }
  }
  if (!supplierName) {
    for (const it of items) {
      if (/^IMFL\s*Depot\s+[^(\n\r]+/i.test(it.str)) {
        supplierName = it.str.trim();
        break;
      }
    }
  }
  if (!supplierName) {
    for (const l of lines) {
      const m = l.match(/IM(?:F)?L\s*DEPOT\s*:\s*([^(\n\r]+)/i) || l.match(/(IMFL\s*Depot\s+[^(\n\r]+)/i);
      if (m) {
        supplierName = m[1].trim();
        break;
      }
    }
  }

  // 4. GSTIN / TIN: 11-digit Telangana VAT TIN (starts with 36) or standard GSTIN
  let gstin: string | null = null;
  const tinItem = items.find((i) => /TIN\s*NO/i.test(i.str));
  if (tinItem) {
    const nearby = items.find(
      (i) => i.page === tinItem.page && Math.abs(i.y - tinItem.y) <= 8 && /^\d{11}$/.test(i.str),
    );
    if (nearby) gstin = nearby.str;
  }
  if (!gstin) {
    for (const it of items) {
      if (/^\d{11}$/.test(it.str) && it.str.startsWith('36')) {
        gstin = it.str;
        break;
      }
    }
  }
  if (!gstin) {
    for (const l of lines) {
      const m = l.match(/TIN\s*NO\.?\s*[:\-]?\s*(\d{11})/i) || l.match(/\b(36\d{9})\b/);
      if (m) {
        gstin = m[1];
        break;
      }
    }
  }

  return {
    invoiceNumber,
    invoiceDate,
    supplierName,
    gstin,
  };
}

/**
 * Extracts Net Invoice Value ((-)Less this Invoice Value) and Special Excise Cess from ICDC items.
 */
export function extractIcdcTotals(
  items: PagePositionedItem[],
  lines: string[],
): { capturedTotal: string | null; specialCess: string | null } {
  let capturedTotal: string | null = null;
  let specialCess: string | null = null;

  // Search items near "(-)Less this Invoice Value:" or "Net Invoice Value:"
  const totalLabels = items.filter((i) => /Less\s*this\s*Invoice\s*Value|Net\s*Invoice\s*Value/i.test(i.str));
  for (const totalItem of totalLabels) {
    const nearby = items.filter(
      (i) => i.page === totalItem.page && Math.abs(i.y - totalItem.y) <= 6 && i.x > totalItem.x,
    );
    for (const n of nearby) {
      const pm = parseMoney(n.str);
      if (pm) {
        capturedTotal = pm;
        break;
      }
    }
    if (capturedTotal) break;
  }

  if (!capturedTotal) {
    for (const l of lines) {
      const m = l.match(/(?:Less\s*this\s*Invoice\s*Value|Net\s*Invoice\s*Value)\s*[:\-]?\s*([₹Rs.\s]*[\d,]+\.\d{2})/i);
      if (m) {
        const pm = parseMoney(m[1]);
        if (pm) {
          capturedTotal = pm;
          break;
        }
      }
    }
  }

  // Special Excise Cess
  const cessLabels = items.filter((i) => /Special\s*Excise\s*Cess/i.test(i.str));
  for (const cessItem of cessLabels) {
    const nearby = items.filter(
      (i) => i.page === cessItem.page && Math.abs(i.y - cessItem.y) <= 6 && i.x > cessItem.x,
    );
    for (const n of nearby) {
      const pm = parseMoney(n.str);
      if (pm) {
        specialCess = pm;
        break;
      }
    }
    if (specialCess) break;
  }

  if (!specialCess) {
    for (const l of lines) {
      const m = l.match(/Special\s*Excise\s*Cess\s*[:\-]?\s*([₹Rs.\s]*[\d,]+\.\d{2})/i);
      if (m) {
        const pm = parseMoney(m[1]);
        if (pm) {
          specialCess = pm;
          break;
        }
      }
    }
  }

  return { capturedTotal, specialCess };
}

interface Anchor {
  page: number;
  slNo: number;
  brandCode: string;
  y: number;
  yUpper?: number;
  yLower?: number;
  items: PagePositionedItem[];
}

const HEADER_WORDS = /^(?:Type|Brand|Name|Product|Pack|Qty|Size|Number|Rate|Total|Unit|Delivered|S\.?No\.?|Sl\.?No\.?)$/i;

/**
 * Extracts line items from ICDC document pages by anchor clustering and column reconstruction.
 */
export function extractIcdcTable(items: PagePositionedItem[]): TableResult {
  const numPages = items.reduce((max, i) => Math.max(max, i.page), 1);

  // 1. Identify row anchors: slNo integer at x in [25, 65] with 4-digit excise brandCode at x in [55, 95] within y +/- 4
  const anchors: Anchor[] = [];
  for (const it of items) {
    if (it.y > 25 && it.y < 815 && /^\d{1,3}$/.test(it.str) && it.x >= 25 && it.x <= 65) {
      const sl = parseInt(it.str, 10);
      const nearbyBrand = items.find(
        (b) => b.page === it.page && Math.abs(b.y - it.y) <= 4 && b.x > it.x && b.x <= 95 && /^\d{4}/.test(b.str),
      );
      if (nearbyBrand) {
        anchors.push({
          page: it.page,
          slNo: sl,
          brandCode: nearbyBrand.str,
          y: it.y,
          items: [],
        });
      }
    }
  }

  anchors.sort((a, b) => a.slNo - b.slNo);

  // 2. Assign text items to anchors by vertical bounds
  for (let p = 1; p <= numPages; p++) {
    const pageAnchors = anchors.filter((a) => a.page === p).sort((a, b) => b.y - a.y);
    if (pageAnchors.length === 0) continue;

    const firstAnchor = pageAnchors[0];
    const prevAnchor = anchors.find((a) => a.slNo === firstAnchor.slNo - 1);
    const headerItem = p === 1 ? items.find((i) => i.page === 1 && /^(?:S|Sl)\.?\s*No/i.test(i.str)) : null;
    const pageTopLimit = headerItem ? headerItem.y - 5 : 810;

    for (let i = 0; i < pageAnchors.length; i++) {
      const cur = pageAnchors[i];
      const upper = (i === 0) ? (p === 1 ? pageTopLimit : cur.y + 16) : (pageAnchors[i - 1].y + cur.y) / 2;
      const lower = (i === pageAnchors.length - 1) ? Math.max(25, cur.y - 35) : (cur.y + pageAnchors[i + 1].y) / 2;
      cur.yUpper = upper;
      cur.yLower = lower;
      const rowItems = items.filter((it) => it.page === p && it.y <= upper && it.y > lower);
      cur.items.push(...rowItems);
    }

    // Assign continuation items above the first anchor to previous anchor
    if (p > 1 && prevAnchor && firstAnchor.yUpper) {
      const contItems = items.filter((it) => it.page === p && it.y > firstAnchor.yUpper! && it.y < 815);
      prevAnchor.items.push(...contItems);
    }
  }

  // 3. Reconstruct line fields
  const lines: ExtractedLine[] = [];

  for (const a of anchors) {
    const isCondensed = a.items.some((i) => i.x > 370 && i.x < 420 && /[\d,]+\.\d{2}/.test(i.str));

    // Brand Name: x between [75, 195] (condensed) or [95, 248] (standard)
    const nameMinX = isCondensed ? 75 : 95;
    const nameMaxX = isCondensed ? 195 : 248;
    const nameItems = a.items.filter(
      (i) => i.x >= nameMinX && i.x <= nameMaxX && !HEADER_WORDS.test(i.str) && !/^\d{4}$/.test(i.str),
    );
    nameItems.sort((i1, i2) => {
      if (i1.page !== i2.page) return i1.page - i2.page;
      return i2.y - i1.y || i1.x - i2.x;
    });
    const brandName = nameItems.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();

    // Pack Size: x between [235, 280] (condensed) or [295, 365] (standard)
    const packMinX = isCondensed ? 235 : 295;
    const packMaxX = isCondensed ? 280 : 365;
    const packItems = a.items.filter((i) => i.x >= packMinX && i.x <= packMaxX);
    packItems.sort((i1, i2) => i2.y - i1.y || i1.x - i2.x);
    const packStr = packItems.map((i) => i.str).join(' ');
    const packMatch = packStr.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:ml)?/i) || packStr.match(/(\d+)\s*pack\s*(\d+)/i);
    let packQuantity = packMatch ? parseInt(packMatch[1], 10) : null;
    const volumeMl = packMatch ? Math.round(parseFloat(packMatch[2])) : null;
    if (!packQuantity) {
      const bcMatch = a.brandCode.match(/\((\d+)\)/);
      if (bcMatch) packQuantity = parseInt(bcMatch[1], 10);
    }

    // Cases: x between [275, 305] (condensed) or [345, 395] (standard)
    const caseMinX = isCondensed ? 275 : 345;
    const caseMaxX = isCondensed ? 305 : 395;
    const caseItem = a.items.find((i) => i.x >= caseMinX && i.x <= caseMaxX && /^\d+$/.test(i.str));
    const cases = caseItem ? parseInt(caseItem.str, 10) : null;

    // Bottles: x between [305, 325] (condensed) or [405, 450] (standard)
    const btlMinX = isCondensed ? 305 : 405;
    const btlMaxX = isCondensed ? 325 : 450;
    const btlItem = a.items.find((i) => i.x >= btlMinX && i.x <= btlMaxX && /^\d+$/.test(i.str));
    const bottles = btlItem ? parseInt(btlItem.str, 10) : 0;

    // Rates:
    // Case Rate: contains '/' or is the upper rate item
    // Bottle Rate: decimal without '/'
    const rateMinX = isCondensed ? 325 : 450;
    const rateMaxX = isCondensed ? 375 : 515;
    const rateItems = a.items.filter(
      (i) => i.x >= rateMinX && i.x <= rateMaxX && !/^(?:Unit|Rate|Btl|\/)$/i.test(i.str),
    );
    const rateNumbers: number[] = [];
    for (const ri of rateItems) {
      const m = ri.str.match(/[\d,]+\.\d{2}/);
      if (m) {
        const p = parseMoney(m[0]);
        if (p) rateNumbers.push(parseFloat(p));
      }
    }
    let caseRate: string | null = null;
    let unitRate: string | null = null;
    if (rateNumbers.length === 1) {
      unitRate = rateNumbers[0].toFixed(2);
    } else if (rateNumbers.length >= 2) {
      unitRate = Math.min(...rateNumbers).toFixed(2);
      caseRate = Math.max(...rateNumbers).toFixed(2);
    }
    const rate = unitRate ?? (caseRate && packQuantity ? (parseFloat(caseRate) / packQuantity).toFixed(2) : caseRate);

    // Total Amount:
    const totalMinX = isCondensed ? 375 : 515;
    const totalMaxX = isCondensed ? 420 : 570;
    const totalItem = a.items.find((i) => i.x >= totalMinX && i.x <= totalMaxX && /^[\d,]+\.\d{2}$/.test(i.str));
    const amount = totalItem ? parseMoney(totalItem.str) : null;

    // SKU is the 4-digit excise brand code
    const sku = a.brandCode.replace(/[^\d]/g, '').slice(0, 4);

    const flags: string[] = [];
    if (cases === null || amount === null) flags.push('INCOMPLETE');
    if (rate === null) flags.push('UNREADABLE_NUMBER');

    lines.push({
      lineNumber: a.slNo,
      description: brandName,
      barcode: null,
      sku,
      quantity: bottles,
      cases,
      rate,
      mrp: null,
      amount,
      taxRate: null,
      packQuantity,
      volumeMl,
      confidence: 100,
      flags,
    });
  }

  const { capturedTotal } = extractIcdcTotals(items, []);

  return {
    lines,
    capturedTotal,
    totalUnreadable: capturedTotal === null,
    headerRowIndex: 0,
    columns: {
      description: 1,
      sku: 0,
      cases: 2,
      quantity: 3,
      rate: 4,
      amount: 5,
    },
  };
}

/**
 * End-to-end ICDC document extractor: items + lines → TableResult + ExtractedHeader + metadata.
 */
export function extractIcdcDocument(items: PagePositionedItem[], lines: string[]): IcdcDocumentResult {
  const header = extractIcdcHeader(items, lines);
  const table = extractIcdcTable(items);
  const { specialCess } = extractIcdcTotals(items, lines);

  return {
    table,
    header,
    headerText: lines,
    specialCess,
  };
}

