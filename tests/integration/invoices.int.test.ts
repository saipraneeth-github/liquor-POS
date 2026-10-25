import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as any });

const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

function buildMultipart(
  file: { filename: string; contentType: string; content: Buffer | string },
  fields: Record<string, string> = {},
): { body: Buffer; contentType: string } {
  const boundary = '----LiquorPosBoundary' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  ));
  chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function stockOf(productId: string, branchId = ctx.branchId) {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, branchId), eq(ctx.schema.stock.productId, productId)));
  return row?.quantity ?? 0;
}

describe('supplier invoices: upload, extraction, review & approval workflow', () => {
  it('uploads a CSV invoice (cashier+), matches catalog items, downloads attachment, reviews & approves (manager+)', async () => {
    const [whisky, beer] = ctx.products;
    const beforeW = await stockOf(whisky.id);
    const beforeB = await stockOf(beer.id);

    // Create an active QTY supplier scheme for Telangana Beverages Corp (target 10 cases)
    const schemeRes = await inject('POST', `/schemes/${ctx.branchId}`, ctx.auth('manager'), {
      supplierName: 'Telangana Beverages Corp',
      schemeName: 'Festive Slab Scheme',
      targetType: 'QTY',
      targetValue: '10',
      rewardDescription: '2 free bottles per 10 cases',
      startDate: '2026-10-01',
      endDate: '2026-12-31',
    });
    expect(schemeRes.statusCode).toBe(201);
    const schemeId = schemeRes.json().scheme.id;

    const csv = [
      'Supplier: Telangana Beverages Corp',
      'Invoice No: TSBCL-2026-101,Date: 2026-10-24',
      'Barcode,Description,Qty,Rate,MRP,Amount',
      '1000000000001,Test Whisky 750ml,12,800.00,1020.00,9600.00',
      ',Unknown Mystery Malt 750ml,6,500.00,700.00,3000.00',
      ',Grand Total,,,,12600.00',
    ].join('\n');

    const mp = buildMultipart({ filename: 'tsbcl-oct.csv', contentType: 'text/csv', content: csv });
    const upRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('cashier'), 'content-type': mp.contentType },
      payload: mp.body,
    });
    expect(upRes.statusCode).toBe(201);
    const uploaded = upRes.json();
    const invId: string = uploaded.invoice.id;
    expect(uploaded.invoice).toMatchObject({
      branchId: ctx.branchId,
      supplierName: 'Telangana Beverages Corp',
      invoiceNumber: 'TSBCL-2026-101',
      status: 'DRAFT',
      source: 'CSV',
      totalAmount: '12600.00',
      linesTotal: '12600.00',
    });
    expect(uploaded.items).toHaveLength(2);
    expect(uploaded.items[0]).toMatchObject({
      productId: whisky.id,
      matchStatus: 'MATCHED',
      matchMethod: 'BARCODE',
      quantity: 12,
      costPrice: '800.00',
      mrp: '1020.00',
      lineCostTotal: '9600.00',
    });
    expect(uploaded.items[0].flags).toContain('MRP_CHANGED');
    expect(uploaded.items[1]).toMatchObject({
      productId: null,
      matchStatus: 'UNMATCHED',
      quantity: 6,
    });

    // Download original attachment and check security headers
    const dlRes = await inject('GET', `/invoices/detail/${invId}/file`, ctx.auth('cashier'));
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['x-content-type-options']).toBe('nosniff');
    expect(dlRes.headers['content-disposition']).toContain('tsbcl-oct.csv');
    expect(dlRes.body).toBe(csv);

    // Review/approve blocked while line 2 is UNMATCHED
    expect((await inject('POST', `/invoices/detail/${invId}/review`, ctx.auth('manager'))).statusCode).toBe(422);
    expect((await inject('POST', `/invoices/detail/${invId}/approve`, ctx.auth('manager'))).statusCode).toBe(422);

    // Cashier edits draft to map line 2 to beer
    const editRes = await inject('PUT', `/invoices/detail/${invId}`, ctx.auth('cashier'), {
      supplierName: 'Telangana Beverages Corp',
      invoiceNumber: 'TSBCL-2026-101',
      invoiceDate: '2026-10-24',
      totalAmount: '12600.00',
      items: [
        {
          id: uploaded.items[0].id,
          productId: whisky.id,
          rawDescription: 'Test Whisky 750ml',
          barcode: '1000000000001',
          quantity: 12,
          costPrice: '800.00',
          mrp: '1020.00',
        },
        {
          id: uploaded.items[1].id,
          productId: beer.id,
          confirmMatch: true,
          rawDescription: 'Test Beer 650ml',
          quantity: 20,
          costPrice: '150.00',
          mrp: '200.00',
        },
      ],
    });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.json().items[1]).toMatchObject({ productId: beer.id, matchStatus: 'MANUAL', lineCostTotal: '3000.00' });

    // Cashier cannot review or approve (403)
    expect((await inject('POST', `/invoices/detail/${invId}/review`, ctx.auth('cashier'))).statusCode).toBe(403);
    expect((await inject('POST', `/invoices/detail/${invId}/approve`, ctx.auth('cashier'))).statusCode).toBe(403);

    // Manager marks REVIEWED, then APPROVES
    const revRes = await inject('POST', `/invoices/detail/${invId}/review`, ctx.auth('manager'));
    expect(revRes.statusCode).toBe(200);
    expect(revRes.json().invoice.status).toBe('REVIEWED');

    const appRes = await inject('POST', `/invoices/detail/${invId}/approve`, ctx.auth('manager'));
    expect(appRes.statusCode).toBe(200);
    expect(appRes.json().invoice.status).toBe('APPROVED');

    // Stock, stock_audit, price_audit, and accounting voucher updated atomically
    expect(await stockOf(whisky.id)).toBe(beforeW + 12);
    expect(await stockOf(beer.id)).toBe(beforeB + 20);

    const audits = await ctx.db.select().from(ctx.schema.stockAudit).where(eq(ctx.schema.stockAudit.referenceId, invId));
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.reason === 'PURCHASE')).toBe(true);

    const vouchers = await ctx.db.select().from(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.sourceId, invId));
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].voucherType).toBe('PURCHASE');

    // Active supplier scheme auto-credited (12 btls / 12 + 20 btls / 12 = 2.67 cases, Rs 12600.00)
    const [updatedScheme] = await ctx.db.select().from(ctx.schema.schemes).where(eq(ctx.schema.schemes.id, schemeId));
    expect(updatedScheme.currentValue).toBe('2.67');

    // Approved invoice is immutable (cannot edit, re-approve, or reject)
    expect((await inject('POST', `/invoices/detail/${invId}/approve`, ctx.auth('manager'))).statusCode).toBe(409);
    expect((await inject('POST', `/invoices/detail/${invId}/reject`, ctx.auth('manager'), { reason: 'Too late' })).statusCode).toBe(409);
    expect((await inject('PUT', `/invoices/detail/${invId}`, ctx.auth('manager'), {
      supplierName: 'Telangana Beverages Corp', invoiceNumber: 'TSBCL-2026-101', items: [
        { productId: whisky.id, rawDescription: 'W', quantity: 1, costPrice: '800.00', mrp: '1020.00' },
      ],
    })).statusCode).toBe(409);
  });

  it('uploads an XLSX workbook, detects DUPLICATE_FILE on re-upload, and handles reject -> re-create', async () => {
    const [whisky] = ctx.products;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoice');
    ws.addRow(['Description', 'Cases', 'Rate', 'MRP', 'Amount']);
    ws.addRow(['Test Whisky 750ml', 2, 9600, 1020, 19200]); // 2 cases * 12 = 24 btls @ 800/btl
    ws.addRow(['Grand Total', '', '', '', 19200]);
    const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());

    const mp1 = buildMultipart(
      { filename: 'purchase.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: xlsxBuf },
      { supplierName: 'Diageo India', invoiceNumber: 'DG-2026-55', invoiceDate: '2026-10-25' },
    );
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('manager'), 'content-type': mp1.contentType },
      payload: mp1.body,
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();
    expect(body1.invoice.source).toBe('EXCEL');
    expect(body1.items[0]).toMatchObject({ quantity: 24, costPrice: '800.00', lineCostTotal: '19200.00' });
    expect(body1.items[0].flags).toContain('CASES_CONVERTED');

    // Duplicate live (branch, supplier, invoiceNumber) -> 409 with existingInvoiceId
    const mpDup = buildMultipart(
      { filename: 'purchase.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: xlsxBuf },
      { supplierName: 'Diageo India', invoiceNumber: 'DG-2026-55' },
    );
    const dupRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('manager'), 'content-type': mpDup.contentType },
      payload: mpDup.body,
    });
    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().existingInvoiceId).toBe(body1.invoice.id);

    // Reject the first draft -> now re-uploading with the same number succeeds and flags DUPLICATE_FILE (same sha256)
    const rejRes = await inject('POST', `/invoices/detail/${body1.invoice.id}/reject`, ctx.auth('manager'), {
      reason: 'Wrong quantities on sheet',
    });
    expect(rejRes.statusCode).toBe(200);
    expect(rejRes.json().invoice.status).toBe('REJECTED');

    const mp2 = buildMultipart(
      { filename: 'purchase.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: xlsxBuf },
      { supplierName: 'Diageo India', invoiceNumber: 'DG-2026-55' },
    );
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('manager'), 'content-type': mp2.contentType },
      payload: mp2.body,
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json().warnings).toContain('DUPLICATE_FILE');
    expect(res2.json().items[0].productId).toBe(whisky.id);
  });

  it('creates a manual draft, requires real invoice number before approval, and lists history with filters', async () => {
    const [whisky] = ctx.products;
    // Manual draft without invoiceNumber gets a DRAFT-* placeholder
    const draftRes = await inject('POST', `/invoices/${ctx.branchId}`, ctx.auth('cashier'), {
      supplierName: 'Pernod Ricard',
      items: [
        { productId: whisky.id, rawDescription: 'Test Whisky 750ml', quantity: 6, costPrice: '800.00', mrp: '1020.00' },
      ],
    });
    expect(draftRes.statusCode).toBe(201);
    const draftId = draftRes.json().invoice.id;
    expect(draftRes.json().invoice.invoiceNumber).toMatch(/^DRAFT-/);

    // Cannot approve while invoiceNumber is a DRAFT-* placeholder
    expect((await inject('POST', `/invoices/detail/${draftId}/approve`, ctx.auth('manager'))).statusCode).toBe(422);

    // List history with search & status filters
    const listAll = await inject('GET', `/invoices/${ctx.branchId}?q=Pernod`, ctx.auth('cashier'));
    expect(listAll.statusCode).toBe(200);
    expect(listAll.json().total).toBe(1);
    expect(listAll.json().items[0]).toMatchObject({
      id: draftId,
      supplierName: 'Pernod Ricard',
      lineCount: 1,
      linesTotal: '4800.00',
    });

    // Reject unsupported file type (415) and cross-branch access (403)
    const badMp = buildMultipart({ filename: 'bad.xls', contentType: 'application/octet-stream', content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]) });
    const badRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${ctx.branchId}/upload`,
      headers: { ...ctx.auth('cashier'), 'content-type': badMp.contentType },
      payload: badMp.body,
    });
    expect(badRes.statusCode).toBe(415);

    expect((await inject('GET', `/invoices/${ctx.branchId}`, otherManager())).statusCode).toBe(403);
    expect((await inject('GET', `/invoices/detail/${draftId}`, otherManager())).statusCode).toBe(403);
    expect((await inject('GET', `/invoices/${ctx.branchId}`, ctx.auth('steward'))).statusCode).toBe(403);
  });
});
