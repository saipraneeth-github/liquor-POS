/**
 * End-to-end on a REAL Telangana ICDC challan (Testing_invoices/ICDCB.pdf): upload → stored depot-ledger figures →
 * the guards that stop a wrong bottle size or a broken total from reaching stock and the books.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { TELANGANA_ICDC_PRODUCTS } from '../../src/db/data/telangana-products.js';

const FILE = join(process.cwd(), 'Testing_invoices', 'ICDCB.pdf');
let ctx: IntegrationContext;
let productByKey: Map<string, string>;     // "code/ml" → product id

beforeAll(async () => {
  ctx = await setupIntegration();
  const [cat] = await ctx.db.insert(ctx.schema.categories).values({ name: 'IMFL', taxRate: '18.00' }).returning();
  const rows = await ctx.db.insert(ctx.schema.products).values(TELANGANA_ICDC_PRODUCTS.map((p) => ({
    name: p.name, brand: p.brand, sku: p.sku, exciseCode: p.exciseCode, mrp: p.mrp, costPrice: p.costPrice,
    volumeMl: p.volumeMl, packQuantity: p.packQuantity, categoryId: cat.id,
  }))).returning();
  productByKey = new Map(rows.map((r) => [`${r.exciseCode}/${r.volumeMl}`, r.id]));
}, 120_000);

afterAll(async () => { await ctx?.app.close(); });

const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });

function multipart(content: Buffer) {
  const boundary = '----ICDC' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ICDCB.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    content, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function stockOf(productId: string) {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId)));
  return row?.quantity ?? 0;
}

async function fresh(id: string): Promise<Detail> {
  const r = await inject('GET', `/invoices/detail/${id}`, ctx.auth('manager'));
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

type Detail = { invoice: Record<string, any>; items: Record<string, any>[] };
const toInput = (d: Detail, overrides: Record<string, unknown> = {}, itemOverrides: Record<number, Record<string, unknown>> = {}) => ({
  supplierName: d.invoice.supplierName,
  invoiceNumber: d.invoice.invoiceNumber,
  invoiceDate: String(d.invoice.invoiceDate).slice(0, 10),
  totalAmount: d.invoice.totalAmount,
  ...overrides,
  items: d.items.map((i, idx) => ({
    id: i.id, productId: i.productId, rawDescription: i.rawDescription, barcode: i.barcode,
    casesDelivered: i.casesDelivered, bottlesDelivered: i.bottlesDelivered, packQuantity: i.packQuantity, volumeMl: i.volumeMl,
    quantity: i.quantity, caseRate: i.caseRate, costPrice: i.costPrice, mrp: i.mrp, taxRate: i.taxRate, extractedAmount: i.extractedAmount,
    ...(itemOverrides[idx] ?? {}),
  })),
});

describe.skipIf(!existsSync(FILE))('ICDC upload: stored depot figures and the guards', () => {
  let uploaded: Detail & { warnings: string[] };

  it('stores every printed figure (e-challan, previous credit, sub total, rounding, taxes, balance) and matches all 30 lines by code + ml', async () => {
    const mp = multipart(readFileSync(FILE));
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('manager'), 'content-type': mp.contentType }, payload: mp.body,
    });
    expect(res.statusCode).toBe(201);
    uploaded = res.json();
    expect(uploaded.invoice).toMatchObject({
      invoiceNumber: 'ICDC032160526003455',
      linesBasicTotal: '873568.58',
      mrpRoundingOff: '68318.30',
      netInvoiceValue: '941886.88',
      totalAmount: '941886.88',
      turnoverTax: '87357.00',
      specialExciseCess: '123660.00',
      tcsAmount: '20585.00',
      challanAmount: '1525000.00',
      previousCredit: '529410.01',
      subTotal: '2054410.01',
      retailerCreditBalance: '880921.13',
      totalInvoiceAmount: '1173488.88',
    });
    expect(uploaded.warnings).not.toContain('TOTAL_MISMATCH');                       // the old false alarm
    expect(uploaded.warnings.filter((w) => /MISMATCH|UNVERIFIED/.test(w))).toEqual([]);
    expect(uploaded.items).toHaveLength(30);
    for (const it of uploaded.items) {
      expect(it.matchStatus, `line ${it.lineNumber}`).toBe('MATCHED');
      expect(it.productId).toBe(productByKey.get(`${it.barcode}/${it.volumeMl}`));   // same code AND ml
    }
    expect((uploaded.meta as any).totalsChecks.map((c: any) => c.status)).toEqual(['OK', 'OK', 'OK', 'OK']);
  }, 60_000);

  it('a manually chosen product of another bottle size blocks review and approval', async () => {
    // line 1 is Kingfisher Premium 650ml → point it at a 330ml product
    const wrong = [...productByKey.entries()].find(([k]) => k.endsWith('/330'))![1];
    const edit = await inject('PUT', `/invoices/detail/${uploaded.invoice.id}`, ctx.auth('manager'),
      toInput(await fresh(uploaded.invoice.id), {}, { 0: { productId: wrong, confirmMatch: true } }));
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().items[0].flags).toContain('VOLUME_MISMATCH');
    const review = await inject('POST', `/invoices/detail/${uploaded.invoice.id}/review`, ctx.auth('manager'));
    expect(review.statusCode).toBe(422);
    expect(review.body).toMatch(/different bottle size/);
    expect((await inject('POST', `/invoices/detail/${uploaded.invoice.id}/approve`, ctx.auth('manager'))).statusCode).toBe(422);
  });

  it('a misread figure (e-challan) breaks the chain and blocks approval until corrected', async () => {
    const bad = await inject('PUT', `/invoices/detail/${uploaded.invoice.id}`, ctx.auth('manager'), toInput(await fresh(uploaded.invoice.id), { challanAmount: '152500.00' }));
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json().invoice.extractionWarnings ?? bad.json().warnings).toContain('SUBTOTAL_MISMATCH');
    const approve = await inject('POST', `/invoices/detail/${uploaded.invoice.id}/approve`, ctx.auth('manager'));
    expect(approve.statusCode).toBe(422);
    expect(approve.body).toMatch(/do not reconcile/);
  });

  it('once the figures are right it approves: stock by code+ml, depot ledger stored, purchase voucher includes MRP rounding', async () => {
    const line1Product = uploaded.items[0].productId as string;
    const before = await stockOf(line1Product);
    const fixed = await inject('PUT', `/invoices/detail/${uploaded.invoice.id}`, ctx.auth('manager'), toInput(await fresh(uploaded.invoice.id), { challanAmount: '1525000.00' }, { 0: { productId: uploaded.items[0].productId, confirmMatch: true } }));
    expect(fixed.statusCode, fixed.body).toBe(200);
    const detail = fixed.json();
    expect((detail.invoice.extractionWarnings ?? []).filter((w: string) => /MISMATCH|UNVERIFIED/.test(w))).toEqual([]);
    expect(detail.invoice).toMatchObject({ challanAmount: '1525000.00', previousCredit: '529410.01', subTotal: '2054410.01', mrpRoundingOff: '68318.30' });

    const approve = await inject('POST', `/invoices/detail/${uploaded.invoice.id}/approve`, ctx.auth('manager'));
    expect(approve.statusCode).toBe(200);
    expect(await stockOf(line1Product)).toBe(before + 720);        // 60 cases × 12

    // the purchase voucher carries the depot's full debit: lines + MRP rounding + turnover tax + cess + TCS
    const [v] = await ctx.db.select().from(ctx.schema.journalVouchers).where(and(
      eq(ctx.schema.journalVouchers.sourceId, uploaded.invoice.id), eq(ctx.schema.journalVouchers.sourceType, 'SUPPLIER_INVOICE')));
    const [sum] = await ctx.db.select({ debit: sql<string>`sum(${ctx.schema.journalLines.debit})` }).from(ctx.schema.journalLines)
      .where(eq(ctx.schema.journalLines.voucherId, v.id));
    expect(Number(sum.debit)).toBeCloseTo(1173488.88, 1);
  }, 60_000);

  it('an approved invoice cannot be deleted; reversing it takes the stock back and nets the books to zero; the number can be re-uploaded', async () => {
    const id = uploaded.invoice.id as string;
    const product = uploaded.items[0].productId as string;
    const stockNow = await stockOf(product);

    const del = await inject('DELETE' as never, `/invoices/detail/${id}`, ctx.auth('manager'));
    expect(del.statusCode).toBe(409);
    expect(del.body).toMatch(/reverse it instead/);

    expect((await inject('POST', `/invoices/detail/${id}/reverse`, ctx.auth('manager'), { reason: 'no' })).statusCode).toBe(400);
    expect((await inject('POST', `/invoices/detail/${id}/reverse`, ctx.auth('cashier'), { reason: 'Uploaded by mistake' })).statusCode).toBe(403);
    const rev = await inject('POST', `/invoices/detail/${id}/reverse`, ctx.auth('manager'), { reason: 'Uploaded against the wrong depot' });
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json().invoice.status).toBe('REVERSED');
    expect(await stockOf(product)).toBe(stockNow - 720);

    // nothing is deleted: purchase, challan and both reversals are all in the journal and net to zero
    const rows = await ctx.db.select({
      type: ctx.schema.journalVouchers.sourceType, code: ctx.schema.accountLedgers.code,
      debit: ctx.schema.journalLines.debit, credit: ctx.schema.journalLines.credit,
    }).from(ctx.schema.journalLines)
      .innerJoin(ctx.schema.journalVouchers, eq(ctx.schema.journalLines.voucherId, ctx.schema.journalVouchers.id))
      .innerJoin(ctx.schema.accountLedgers, eq(ctx.schema.journalLines.ledgerId, ctx.schema.accountLedgers.id))
      .where(eq(ctx.schema.journalVouchers.sourceId, id));
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['SUPPLIER_INVOICE', 'SUPPLIER_CHALLAN', 'SUPPLIER_INVOICE_REVERSAL', 'SUPPLIER_CHALLAN_REVERSAL']));
    const net = (code: string) => rows.filter((r) => r.code === code).reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
    for (const code of ['SUNDRY_CREDITORS', 'PURCHASES', 'BANK', 'PURCHASES_EXCISE_ROUNDING', 'EXCISE_TURNOVER_TAX', 'SPECIAL_EXCISE_CESS', 'TCS_RECEIVABLE']) {
      expect(net(code), code).toBeCloseTo(0, 2);
    }

    // reversing twice is refused, and the same invoice number can be uploaded again
    expect((await inject('POST', `/invoices/detail/${id}/reverse`, ctx.auth('manager'), { reason: 'Again please' })).statusCode).toBe(409);
    const mp = multipart(readFileSync(FILE));
    const again = await ctx.app.inject({
      method: 'POST', url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('manager'), 'content-type': mp.contentType }, payload: mp.body,
    });
    expect(again.statusCode, again.body).toBe(201);
    // an unapproved draft can still be deleted
    expect((await inject('DELETE' as never, `/invoices/detail/${again.json().invoice.id}`, ctx.auth('manager'))).statusCode).toBe(200);
  }, 60_000);
});
