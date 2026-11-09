/**
 * icdc.engine.ts — PURE: specialized Telangana Excise ICDC invoice extraction.
 * Handles official Telangana State Prohibition & Excise Department Invoice Cum Delivery Challan (ICDC)
 * documents, accurately resolving multi-line brand names across line/page wraps, dual quantities (cases + bottles),
 * excise code (SKU) extraction, per-bottle unit rates, and Net Invoice Value totals.
 */
import { Decimal } from 'decimal.js';
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
  mrpRoundingOff: string | null;
  linesBasicTotal: string | null;
  turnoverTax: string | null;
  tcsAmount: string | null;
  challanAmount: string | null;
  challanNumber: string | null;
  previousCredit: string | null;
  subTotal: string | null;
  netInvoiceValue: string | null;
  totalInvoiceAmount: string | null;
  retailerCreditBalance: string | null;
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

  // 5. Shop Name (Retailer Name): e.g. "Spirit Nation Wines"
  let shopName: string | null = null;
  for (const it of items) {
    if (it.y > 600 && it.page === 1) {
      const m = it.str.match(/Name\s*:\s*([^Code\n\r]+)/i);
      if (m && m[1].trim() && !/Licensee|Phone/i.test(m[1])) {
        shopName = m[1].replace(/\s*Code\s*:?.*$/i, '').trim();
        break;
      }
    }
  }
  if (!shopName) {
    const nameLabel = items.find((i) => i.page === 1 && i.y > 600 && /^Name\s*:?$/i.test(i.str.trim()));
    if (nameLabel) {
      const nearby = items.filter(
        (other) => other.page === 1 && Math.abs(other.y - nameLabel.y) <= 4 && other.x > nameLabel.x && other.x < 380,
      );
      if (nearby.length > 0) {
        const candidate = nearby.map((n) => n.str).join(' ').replace(/\s*Code\s*:?.*$/i, '').trim();
        if (candidate && !/Licensee|Phone/i.test(candidate)) {
          shopName = candidate;
        }
      }
    }
  }
  if (!shopName) {
    for (const l of lines) {
      const m = l.match(/(?:^|\s)Name\s*:\s*([^Code\n\r]+?)(?:\s+Code\s*:|$)/i);
      if (m && m[1].trim() && !/Licensee|Phone/i.test(m[1])) {
        shopName = m[1].trim();
        break;
      }
    }
  }

  return {
    invoiceNumber,
    invoiceDate,
    supplierName,
    shopName: shopName ?? null,
    gstin,
  };
}

/**
 * Extracts Net Invoice Value ((-)Less this Invoice Value) and Special Excise Cess from ICDC items.
 */
export interface IcdcTotalsResult {
  capturedTotal: string | null;
  specialCess: string | null;
  mrpRoundingOff: string | null;
  linesBasicTotal: string | null;
  turnoverTax: string | null;
  tcsAmount: string | null;
  challanAmount: string | null;
  challanNumber: string | null;
  previousCredit: string | null;
  subTotal: string | null;
  netInvoiceValue: string | null;
  totalInvoiceAmount: string | null;
  retailerCreditBalance: string | null;
}

const MONEY_STRICT = /^(?:Rs\.?\s*)?\d{1,3}(?:,\d{2,3})*\.\d{2}$|^(?:Rs\.?\s*)?\d+\.\d{2}$/;
const MONEY_ANY = /^(?:Rs\.?\s*)?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$|^(?:Rs\.?\s*)?\d+(?:\.\d{1,2})?$/;
const ROW_TOLERANCE = 2.5;

/** Money printed inside a label's own text after the label ("TCS (2%): 8,811.00", "Rs.1,016,903.89"). */
function moneyAfter(str: string, labelRe: RegExp): string | null {
  const m = str.match(labelRe);
  if (!m) return null;
  const tail = str.slice((m.index ?? 0) + m[0].length);
  const t = tail.match(/(?:Rs\.?\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*$/i);
  return t ? parseMoney(t[1]) : null;
}

/**
 * Reads one figure of the totals block: the amount printed on the SAME ROW as the label (same page, same baseline).
 * Never "the nearest number within N points" — rows are only ~8pt apart, so that grabs a neighbour's amount.
 */
function valueOnRow(items: PagePositionedItem[], labelRe: RegExp, opts: { integer?: boolean } = {}): string | null {
  const pattern = opts.integer ? MONEY_ANY : MONEY_STRICT;
  for (const h of items.filter((i) => labelRe.test(i.str))) {
    const own = moneyAfter(h.str, labelRe);
    if (own) return own;
    const same = items
      .filter((i) => i !== h && i.page === h.page && Math.abs(i.y - h.y) <= ROW_TOLERANCE && i.x > h.x && pattern.test(i.str.trim()))
      .sort((a, b) => a.x - b.x);
    for (const c of same) {
      const pm = parseMoney(c.str.trim());
      if (pm) return pm;
    }
  }
  return null;
}

/** Fallback: label and amount in the same extracted text line. */
function valueInLines(lines: string[], labelRe: RegExp): string | null {
  for (const l of lines) {
    const m = l.match(new RegExp(labelRe.source + '\\s*[:\\-]?\\s*(?:Rs\\.?\\s*)?(\\d[\\d,]*(?:\\.\\d{1,2})?)', 'i'));
    if (m) {
      const pm = parseMoney(m[1]);
      if (pm) return pm;
    }
  }
  return null;
}

/**
 * "Invoice Value", "MRP Rounding Off" and "Net Invoice Value" are printed as a three-row block whose labels wrap
 * ("Net" / "Invoice" / "Value:") so the amounts do NOT sit on the label's baseline. They are identified by the
 * arithmetic that must hold between them: invoiceValue + roundingOff = net.
 */
function invoiceValueBlock(items: PagePositionedItem[], net: string | null): { invoiceValue: string; roundingOff: string; net: string } | null {
  let best: { invoiceValue: string; roundingOff: string; net: string; dist: number } | null = null;
  for (const label of items.filter((i) => /Rounding/i.test(i.str))) {
    const cands = items
      .filter((i) => i.page === label.page && Math.abs(i.y - label.y) <= 75 && i.x > label.x + 30 && MONEY_STRICT.test(i.str.trim()))
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((i) => ({ it: i, v: new Decimal(parseMoney(i.str.trim()) ?? 'NaN') }))
      .filter((c) => !c.v.isNaN());
    for (let a = 0; a < cands.length; a++) {
      for (let b = a + 1; b < cands.length; b++) {
        for (let c = b + 1; c < cands.length; c++) {
          const sum = cands[a].v.plus(cands[b].v);
          if (cands[a].v.gt(0) && sum.minus(cands[c].v).abs().lte('0.05') && (net === null || cands[c].v.minus(net).abs().lte('0.05'))) {
            const dist = Math.abs(cands[b].it.y - label.y);
            if (!best || dist < best.dist) {
              best = { invoiceValue: cands[a].v.toFixed(2), roundingOff: cands[b].v.toFixed(2), net: cands[c].v.toFixed(2), dist };
            }
          }
        }
      }
    }
  }
  return best ? { invoiceValue: best.invoiceValue, roundingOff: best.roundingOff, net: best.net } : null;
}

export function extractIcdcTotals(
  items: PagePositionedItem[],
  lines: string[],
): IcdcTotalsResult {
  const get = (re: RegExp, opts?: { integer?: boolean }) => valueOnRow(items, re, opts) ?? valueInLines(lines, re);

  // "(-)Less this Invoice Value" is printed on one row with its amount: the reliable source of the net value
  const capturedTotal = get(/\(-\)\s*Less\s*this\s*Invoice\s*Value\s*:?/i);

  const block = invoiceValueBlock(items, capturedTotal);
  const netInvoiceValue = capturedTotal ?? block?.net ?? null;
  const linesBasicTotal = block?.invoiceValue ?? null;
  const mrpRoundingOff = block?.roundingOff ?? null;

  const specialCess = get(/Special\s*Excise\s*Cess\s*:?/i);
  const turnoverTax = get(/Turnover\s*Tax\s*:?/i);
  const tcsAmount = get(/^\s*TCS\b(?:\s*\(\d+(?:\.\d+)?%\))?\s*:?/i);
  const challanAmount = get(/e-challan\s*\/\s*DD\s*Amount\s*:?/i, { integer: true });
  const previousCredit = get(/Previous\s*Credit\s*:?/i, { integer: true });
  const subTotal = get(/Sub\s*Total\s*:?/i, { integer: true });
  const retailerCreditBalance = get(/(?:Retailer\s*Credit\s*Balance|Amount\s*Credited\s*\([^)]+\))\s*:?\s*(?:Rs\.?)?/i, { integer: true });

  // No.e-challan/DD
  let challanNumber: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/No\.?\s*e-challan\s*\/\s*DD/i.test(l)) {
      const m = l.match(/No\.?\s*e-challan\s*\/\s*DD\s*[:\-]?\s*(\d+)/i);
      const count = m ? m[1] : '1';
      let ref = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        if (/^\d+\.[\d\w\/]+\s*Rs\.?\s*[\d,]+/i.test(lines[j].trim())) {
          ref = lines[j].trim();
          break;
        }
      }
      challanNumber = ref ? `${count} (${ref})` : count;
      break;
    }
  }

  // Total payable to the depot for this challan = net + turnover tax + special excise cess + TCS
  let totalInvoiceAmount: string | null = null;
  if (netInvoiceValue) {
    let tot = new Decimal(netInvoiceValue);
    if (turnoverTax) tot = tot.plus(turnoverTax);
    if (specialCess) tot = tot.plus(specialCess);
    if (tcsAmount) tot = tot.plus(tcsAmount);
    totalInvoiceAmount = tot.toFixed(2);
  }

  return {
    capturedTotal,
    specialCess,
    mrpRoundingOff,
    linesBasicTotal,
    turnoverTax,
    tcsAmount,
    challanAmount,
    challanNumber,
    previousCredit,
    subTotal,
    netInvoiceValue,
    totalInvoiceAmount,
    retailerCreditBalance,
  };
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

/**
 * Brand name hygiene: HTML-entity leftovers ("JACOB #039;S" → "JACOB'S") and the page-footer / totals-header text
 * that sits under the last row of a page ("… WHISKY IMFL/FL Particulars (Cases/Btls) Invoice Qty …").
 */
export function cleanBrandName(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&?#0*39;/g, "'")
    .replace(/\s*\bIMFL\/FL\b.*$/i, '')
    .replace(/\s*\b(?:Particulars|Invoice\s*Qty|Breakage\s*Qty|Shortage\s*Qty|Reverted\s*Qty)\b.*$/i, '')
    .replace(/\s*\(Cases\/Btls\).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADER_WORDS =/^(?:Type|Brand|Name|Product|Pack|Qty|Size|Number|Rate|Total|Unit|Delivered|S\.?No\.?|Sl\.?No\.?)$/i;

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
      let lower: number;
      if (i === pageAnchors.length - 1) {
        lower = Math.max(25, cur.y - 35);
      } else {
        const next = pageAnchors[i + 1];
        const inBetween = items.filter((it) => it.page === p && it.y <= cur.y && it.y >= next.y);
        const ys = [...new Set(inBetween.map((it) => it.y))].sort((a, b) => b - a);
        let maxGap = 0;
        let splitY = (cur.y + next.y) / 2;
        for (let j = 0; j < ys.length - 1; j++) {
          const gap = ys[j] - ys[j + 1];
          if (gap > maxGap) {
            maxGap = gap;
            splitY = (ys[j] + ys[j + 1]) / 2;
          }
        }
        lower = maxGap >= 12 ? splitY : (cur.y + next.y) / 2;
      }
      const upper = (i === 0) ? (p === 1 ? pageTopLimit : cur.y + 16) : pageAnchors[i - 1].yLower!;
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

    // Brand Name: x between [75, 195] (condensed) or [95, 226] (standard, excluding Product Type column at x >= 228)
    const nameMinX = isCondensed ? 75 : 95;
    const nameMaxX = isCondensed ? 195 : 226;
    const nameItems = a.items.filter(
      (i) => i.x >= nameMinX && i.x <= nameMaxX && !HEADER_WORDS.test(i.str) && !/^\d{4}$/.test(i.str),
    );
    nameItems.sort((i1, i2) => {
      if (i1.page !== i2.page) return i1.page - i2.page;
      return i2.y - i1.y || i1.x - i2.x;
    });
    const brandName = cleanBrandName(nameItems.map((i) => i.str).join(' '));

    // Pack Size: x between [235, 280] (condensed) or [295, 335] (standard)
    const packMinX = isCondensed ? 235 : 295;
    const packMaxX = isCondensed ? 280 : 335;
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

    // Cases: x between [275, 305] (condensed) or [335, 395] (standard)
    const caseMinX = isCondensed ? 275 : 335;
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
      // The 4-digit excise brand code is NOT a barcode (one code covers several sizes); it travels as `sku`
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
      caseRate: caseRate ?? null,
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
  const totals = extractIcdcTotals(items, lines);

  return {
    table,
    header,
    headerText: lines,
    specialCess: totals.specialCess,
    mrpRoundingOff: totals.mrpRoundingOff,
    linesBasicTotal: totals.linesBasicTotal,
    turnoverTax: totals.turnoverTax,
    tcsAmount: totals.tcsAmount,
    challanAmount: totals.challanAmount,
    challanNumber: totals.challanNumber,
    previousCredit: totals.previousCredit,
    subTotal: totals.subTotal,
    netInvoiceValue: totals.netInvoiceValue,
    totalInvoiceAmount: totals.totalInvoiceAmount,
    retailerCreditBalance: totals.retailerCreditBalance,
  };
}

