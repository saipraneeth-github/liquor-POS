import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let billId: string;
let kotId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  await ctx.db.update(ctx.schema.branches)
    .set({ gstin: '36ABCDE1234F1Z5', address: '1 High St, Hyderabad' })
    .where(eq(ctx.schema.branches.id, ctx.branchId));

  // Bar item with pegs + a kitchen item on one bill
  const bar = (await ctx.app.inject({
    method: 'POST', url: '/api/v1/menu/bar', headers: ctx.auth('manager'),
    payload: { name: 'Single Malt 750ml', categoryName: 'Whisky', price: '3000', gstRate: '18', volumeMl: 750,
      servings: [{ label: '60 ml', volumeMl: 60, price: '300' }] },
  })).json();
  await ctx.db.insert(ctx.schema.stock).values({ branchId: ctx.branchId, productId: bar.id, quantity: 3 });
  const food = (await ctx.app.inject({
    method: 'POST', url: '/api/v1/menu/kitchen', headers: ctx.auth('manager'),
    payload: { name: 'Paneer Tikka', categoryName: 'Starters', price: '240', gstRate: '5' },
  })).json();

  const b = await ctx.app.inject({
    method: 'POST', url: '/api/v1/bills', headers: ctx.auth('cashier'),
    payload: { branchId: ctx.branchId, paymentMode: 'CASH', items: [
      { productId: bar.id, servingId: bar.servings[0].id, quantity: 3 },
      { productId: food.id, quantity: 2 },
    ] },
  });
  billId = b.json().id;

  // KOT with a peg on an open table
  const table = (await ctx.app.inject({ method: 'POST', url: `/api/v1/tables/${ctx.branchId}`, headers: ctx.auth('manager'), payload: { name: 'T-4' } })).json().table;
  const session = (await ctx.app.inject({ method: 'POST', url: `/api/v1/tables/${table.id}/open`, headers: ctx.auth('cashier'), payload: { branchId: ctx.branchId } })).json().session;
  const kot = await ctx.app.inject({
    method: 'POST', url: '/api/v1/kot', headers: ctx.auth('steward'),
    payload: { tableSessionId: session.id, branchId: ctx.branchId, destination: 'BAR',
      items: [{ productId: bar.id, servingId: bar.servings[0].id, quantity: 2, notes: 'No ice' }] },
  });
  expect(kot.statusCode).toBe(201);
  expect(kot.json().kotOrder.items[0]).toMatchObject({ servingLabel: '60 ml', unitPrice: '300.00', servingMl: 60 });
  kotId = kot.json().kotOrder.id;
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

const get = (url: string, role: 'cashier' | 'steward' | 'manager' = 'cashier') =>
  ctx.app.inject({ method: 'GET', url, headers: ctx.auth(role) });

describe('bill printing with GST', () => {
  it('renders text with GSTIN, per-item tax, CGST/SGST and the rate summary', async () => {
    const res = await get(`/api/v1/print/bills/${billId}?format=text`);
    expect(res.statusCode).toBe(200);
    const t = res.body;
    expect(t).toContain('GSTIN: 36ABCDE1234F1Z5');
    expect(t).toContain('TAX INVOICE');
    expect(t).toContain('Single Malt 750ml (60 ml)');
    expect(t).toContain('Paneer Tikka');
    expect(t).toContain('GST 18%: CGST 68.64 SGST 68.65');
    expect(t).toContain('GST 5%: CGST 11.43 SGST 11.43');
    expect(t).toMatch(/TOTAL\s+1380\.00/);
    expect(t).toMatch(/5\.00\s+457\.14\s+11\.43\s+11\.43/);
  });

  it('serves html and json, and escpos bytes', async () => {
    const html = await get(`/api/v1/print/bills/${billId}?format=html`);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.body).toContain('<pre>');
    const json = await get(`/api/v1/print/bills/${billId}?format=json`);
    expect(json.json()).toMatchObject({ gstin: '36ABCDE1234F1Z5', total: 1380 });
    const raw = await get(`/api/v1/print/bills/${billId}?format=escpos`);
    expect(raw.headers['content-type']).toMatch(/octet-stream/);
    expect(raw.rawPayload[0]).toBe(0x1b);
  });

  it('prints IGST when asked', async () => {
    const t = (await get(`/api/v1/print/bills/${billId}?format=text&interState=true`)).body;
    expect(t).toContain('IGST');
    expect(t).not.toContain('SGST');
  });

  it('denies other branches and steward role', async () => {
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/print/bills/${billId}`, headers: other })).statusCode).toBe(403);
    expect((await get(`/api/v1/print/bills/${billId}`, 'steward')).statusCode).toBe(403);
  });
});

describe('KOT printing', () => {
  it('prints table, destination, serving and notes without prices', async () => {
    const res = await get(`/api/v1/print/kot/${kotId}?format=text`, 'steward');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('BAR ORDER');
    expect(res.body).toContain('Table: T-4');
    expect(res.body).toContain('2 x Single Malt 750ml (60 ml)');
    expect(res.body).toContain('No ice');
    expect(res.body).not.toMatch(/\d+\.\d{2}/);
  });
});

describe('network printer', () => {
  it('refuses to send when no printer is configured', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/print/bills/${billId}/send`, headers: ctx.auth('cashier') });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/No network printer/);
  });

  it('owner configures a printer; bill and KOT bytes reach it', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((sock) => sock.on('data', (d) => received.push(d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const patch = await ctx.app.inject({
        method: 'PATCH', url: `/api/v1/branches/${ctx.branchId}`, headers: ctx.auth('owner'),
        payload: { printerHost: '127.0.0.1', printerPort: port, paperWidth: '80mm' },
      });
      expect(patch.statusCode).toBe(200);

      const sentBill = await ctx.app.inject({ method: 'POST', url: `/api/v1/print/bills/${billId}/send`, headers: ctx.auth('cashier') });
      expect(sentBill.json()).toEqual({ sent: true });
      const sentKot = await ctx.app.inject({ method: 'POST', url: `/api/v1/print/kot/${kotId}/send`, headers: ctx.auth('steward') });
      expect(sentKot.json()).toEqual({ sent: true });
      await new Promise((r) => setTimeout(r, 100));

      const all = Buffer.concat(received).toString('latin1');
      expect(all).toContain('TAX INVOICE');
      expect(all).toContain('BAR ORDER');
      expect(all).toContain('CGST');
    } finally {
      server.close();
    }
  });

  it('reports an unreachable printer as an error, not a crash', async () => {
    await ctx.db.update(ctx.schema.branches).set({ printerHost: '127.0.0.1', printerPort: 1 }).where(eq(ctx.schema.branches.id, ctx.branchId));
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/print/bills/${billId}/send`, headers: ctx.auth('cashier') });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/unreachable/);
  });
});
