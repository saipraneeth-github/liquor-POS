/**
 * Sale types (Walk-in = default, Janata, ...): a price list + its own counter.
 * Walk-in is priced by products.mrp and holds whatever is left of the shop's stock; Janata has its own price per product
 * and an explicit counter. Counter sheets are kept per type, and sales found by a sheet that no POS bill covered are booked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });

async function stockRow(productId: string) {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId)));
  return row?.quantity ?? 0;
}
async function counters(productId: string) {
  const res = await inject('GET', `/sale-types/${ctx.branchId}/stock`, ctx.auth('manager'));
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { types: { id: string; code: string }[]; products: { productId: string; total: number; counters: Record<string, number> }[] };
  const p = body.products.find((x) => x.productId === productId)!;
  const byCode: Record<string, number> = {};
  for (const t of body.types) byCode[t.code] = p.counters[t.id];
  return { total: p.total, ...byCode };
}
const bill = (items: { productId: string; quantity: number }[], saleTypeId?: string) =>
  inject('POST', '/bills', ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH', items, ...(saleTypeId ? { saleTypeId } : {}) });

describe('sale types', () => {
  let whisky: { id: string }, beer: { id: string };
  let janata: { id: string; code: string; isDefault: boolean };
  let walkIn: { id: string; code: string; isDefault: boolean };

  it('every shop has Walk-in (default) and Janata', async () => {
    [whisky, beer] = ctx.products;
    const res = await inject('GET', `/sale-types/${ctx.branchId}`, ctx.auth('cashier'));
    expect(res.statusCode).toBe(200);
    const types = res.json() as { id: string; code: string; isDefault: boolean }[];
    walkIn = types.find((t) => t.code === 'WALK_IN')!;
    janata = types.find((t) => t.code === 'JANATA')!;
    expect(walkIn.isDefault).toBe(true);
    expect(janata.isDefault).toBe(false);
  });

  it('prices are edited in one place, per product per type, and audited; the default price stays the MRP', async () => {
    const set = await inject('PUT', `/sale-types/${ctx.branchId}/prices`, ctx.auth('manager'), {
      prices: [{ productId: whisky.id, saleTypeId: janata.id, price: '900.00' }],
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ changed: 1 });

    const matrix = (await inject('GET', `/sale-types/${ctx.branchId}/prices`, ctx.auth('cashier'))).json() as {
      products: { id: string; mrp: string; prices: Record<string, string> }[];
    };
    const row = matrix.products.find((p) => p.id === whisky.id)!;
    expect(row.mrp).toBe('1000.00');
    expect(row.prices[janata.id]).toBe('900.00');
    expect(matrix.products.find((p) => p.id === beer.id)!.prices[janata.id]).toBeUndefined();   // no price = not sold as Janata

    const audit = await ctx.db.select().from(ctx.schema.priceAudit)
      .where(and(eq(ctx.schema.priceAudit.productId, whisky.id), eq(ctx.schema.priceAudit.saleTypeId, janata.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ oldMrp: null, newMrp: '900.00', userId: ctx.users.manager.id });

    // the default type is priced by the MRP, not by this table
    const bad = await inject('PUT', `/sale-types/${ctx.branchId}/prices`, ctx.auth('manager'), {
      prices: [{ productId: whisky.id, saleTypeId: walkIn.id, price: '1.00' }],
    });
    expect(bad.statusCode).toBe(422);
    // a cashier cannot change prices
    expect((await inject('PUT', `/sale-types/${ctx.branchId}/prices`, ctx.auth('cashier'), {
      prices: [{ productId: whisky.id, saleTypeId: janata.id, price: '1.00' }],
    })).statusCode).toBe(403);
  });

  it('a Janata bill uses the Janata price and needs a price for every item', async () => {
    const noPrice = await bill([{ productId: beer.id, quantity: 1 }], janata.id);
    expect(noPrice.statusCode).toBe(422);
    expect(noPrice.body).toMatch(/No Janata price/);

    // stock must be in the Janata counter first: move 30 whisky from Walk-in
    const move = await inject('POST', `/sale-types/${ctx.branchId}/transfer`, ctx.auth('manager'), { productId: whisky.id, toSaleTypeId: janata.id, quantity: 30 });
    expect(move.statusCode, move.body).toBe(201);
    expect(await counters(whisky.id)).toMatchObject({ total: 100, WALK_IN: 70, JANATA: 30 });

    const sale = await bill([{ productId: whisky.id, quantity: 5 }], janata.id);
    expect(sale.statusCode, sale.body).toBe(201);
    const b = sale.json().bill ?? sale.json();
    expect(b.saleTypeId).toBe(janata.id);
    expect(b.items[0].unitPrice).toBe('900.00');
    expect(b.total).toBe('4500.00');
    expect(await counters(whisky.id)).toMatchObject({ total: 95, WALK_IN: 70, JANATA: 25 });

    // a Walk-in bill at the same time uses the MRP
    const walk = await bill([{ productId: whisky.id, quantity: 1 }]);
    expect(walk.statusCode).toBe(201);
    expect((walk.json().bill ?? walk.json()).items[0].unitPrice).toBe('1000.00');
    expect((walk.json().bill ?? walk.json()).saleTypeId).toBeNull();
    expect(await counters(whisky.id)).toMatchObject({ total: 94, WALK_IN: 69, JANATA: 25 });
  });

  it('each counter only sells its own bottles', async () => {
    // Walk-in has 69; asking for 70 must not touch the 25 held by Janata
    const over = await bill([{ productId: whisky.id, quantity: 70 }]);
    expect(over.statusCode).toBe(422);
    expect(over.body).toMatch(/Insufficient stock/);
    // Janata has 25; 26 must not take Walk-in's bottles
    const overJ = await bill([{ productId: whisky.id, quantity: 26 }], janata.id);
    expect(overJ.statusCode).toBe(422);
    expect(overJ.body).toMatch(/Insufficient Janata stock|Insufficient stock/);
    expect(await counters(whisky.id)).toMatchObject({ total: 94, WALK_IN: 69, JANATA: 25 });     // nothing moved

    // breakage comes out of Walk-in and cannot eat Janata's bottles either
    const breakage = await inject('POST', `/compliance/breakage/${ctx.branchId}`, ctx.auth('cashier'), { productId: whisky.id, quantity: 70, reason: 'Dropped crate' });
    expect(breakage.statusCode).toBe(422);
  });

  it('voiding a Janata bill returns the bottles to the Janata counter', async () => {
    const sale = await bill([{ productId: whisky.id, quantity: 4 }], janata.id);
    const id = (sale.json().bill ?? sale.json()).id as string;
    expect(await counters(whisky.id)).toMatchObject({ JANATA: 21, WALK_IN: 69 });
    const voided = await inject('POST', `/bills/${id}/void`, ctx.auth('manager'), { voidReason: 'Wrong sale type' });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await counters(whisky.id)).toMatchObject({ total: 94, WALK_IN: 69, JANATA: 25 });
  });

  it('a price cannot be removed while the counter still holds bottles of that product', async () => {
    const res = await inject('PUT', `/sale-types/${ctx.branchId}/prices`, ctx.auth('manager'), {
      prices: [{ productId: whisky.id, saleTypeId: janata.id, price: null }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/move them back/);
  });

  it('moving more than a counter holds is refused; moving back works', async () => {
    const tooMany = await inject('POST', `/sale-types/${ctx.branchId}/transfer`, ctx.auth('manager'), { productId: whisky.id, toSaleTypeId: janata.id, quantity: 500 });
    expect(tooMany.statusCode).toBe(422);
    const noPrice = await inject('POST', `/sale-types/${ctx.branchId}/transfer`, ctx.auth('manager'), { productId: beer.id, toSaleTypeId: janata.id, quantity: 1 });
    expect(noPrice.statusCode).toBe(422);
    expect(noPrice.body).toMatch(/Set a Janata price/);
    const back = await inject('POST', `/sale-types/${ctx.branchId}/transfer`, ctx.auth('manager'), { productId: whisky.id, fromSaleTypeId: janata.id, quantity: 5 });
    expect(back.statusCode).toBe(201);
    expect(await counters(whisky.id)).toMatchObject({ total: 94, WALK_IN: 74, JANATA: 20 });
  });
});

describe('counter sheets per sale type', () => {
  const today = businessDateOf();
  let beerId: string, janataId: string, janataSheet: string, walkInSheet: string;

  it('Walk-in and Janata each get their own sheet for the same day, at their own rate and stock', async () => {
    beerId = ctx.products[1].id;
    const types = (await inject('GET', `/sale-types/${ctx.branchId}`, ctx.auth('cashier'))).json() as { id: string; code: string }[];
    janataId = types.find((t) => t.code === 'JANATA')!.id;
    expect((await inject('PUT', `/sale-types/${ctx.branchId}/prices`, ctx.auth('manager'), { prices: [{ productId: beerId, saleTypeId: janataId, price: '180.00' }] })).statusCode).toBe(200);
    expect((await inject('POST', `/sale-types/${ctx.branchId}/transfer`, ctx.auth('manager'), { productId: beerId, toSaleTypeId: janataId, quantity: 20 })).statusCode).toBe(201);

    const walk = await inject('POST', `/counter-sheets/${ctx.branchId}`, ctx.auth('cashier'), { sheetDate: today });
    expect(walk.statusCode, walk.body).toBe(201);
    walkInSheet = walk.json().id;
    const jan = await inject('POST', `/counter-sheets/${ctx.branchId}`, ctx.auth('cashier'), { sheetDate: today, saleTypeId: janataId });
    expect(jan.statusCode, jan.body).toBe(201);
    janataSheet = jan.json().id;
    expect(jan.json().saleTypeName).toBe('Janata');
    expect(walk.json().saleTypeName).toBeNull();

    // one sheet per day per type
    const dup = await inject('POST', `/counter-sheets/${ctx.branchId}`, ctx.auth('cashier'), { sheetDate: today, saleTypeId: janataId });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toMatch(/Janata/);

    const jBeer = (jan.json().lines as { productId: string; openingBottles: number; transferBottles: number; closingBottles: number; sellingRate: string }[]).find((l) => l.productId === beerId)!;
    expect(jBeer).toMatchObject({ openingBottles: 0, transferBottles: 20, closingBottles: 20, sellingRate: '180.00' });
    const wBeer = (walk.json().lines as typeof jBeer[]).find((l) => l.productId === beerId)!;
    expect(wBeer).toMatchObject({ openingBottles: 100, transferBottles: -20, closingBottles: 80, sellingRate: '200.00' });
  });

  it('a Janata bill moves only the Janata sheet', async () => {
    const sale = await bill([{ productId: beerId, quantity: 4 }], janataId);
    expect(sale.statusCode, sale.body).toBe(201);
    const j = (await inject('GET', `/counter-sheets/sheet/${janataSheet}`, ctx.auth('cashier'))).json();
    expect(j.lines.find((l: { productId: string }) => l.productId === beerId)).toMatchObject({ soldBottles: 4, closingBottles: 16, lineRevenue: '720.00' });
    const w = (await inject('GET', `/counter-sheets/sheet/${walkInSheet}`, ctx.auth('cashier'))).json();
    expect(w.lines.find((l: { productId: string }) => l.productId === beerId)).toMatchObject({ soldBottles: 0, closingBottles: 80 });
  });

  it('posting corrects that counter and books the sales no POS bill covered; un-posting reverses both', async () => {
    // two more bottles left the Janata counter without a bill (count says 14, not 16)
    const edit = await inject('PUT', `/counter-sheets/sheet/${janataSheet}/lines`, ctx.auth('cashier'), { lines: [{ productId: beerId, closingBottles: 14 }] });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().lines.find((l: { productId: string }) => l.productId === beerId)).toMatchObject({ soldBottles: 6, lineRevenue: '1080.00' });

    const post = await inject('POST', `/counter-sheets/sheet/${janataSheet}/post`, ctx.auth('manager'));
    expect(post.statusCode, post.body).toBe(200);
    expect(await counters(beerId)).toMatchObject({ total: 94, JANATA: 14, WALK_IN: 80 });      // 100 − 4 billed − 2 unbilled

    const vouchers = async (sourceType: string) => ctx.db.select().from(ctx.schema.journalVouchers)
      .where(and(eq(ctx.schema.journalVouchers.sourceType, sourceType), eq(ctx.schema.journalVouchers.sourceId, janataSheet)));
    const [v] = await vouchers('COUNTER_SHEET');
    expect(v).toBeTruthy();
    const lines = await ctx.db.select({ code: ctx.schema.accountLedgers.code, debit: ctx.schema.journalLines.debit, credit: ctx.schema.journalLines.credit })
      .from(ctx.schema.journalLines).innerJoin(ctx.schema.accountLedgers, eq(ctx.schema.journalLines.ledgerId, ctx.schema.accountLedgers.id))
      .where(eq(ctx.schema.journalLines.voucherId, v.id));
    const by = Object.fromEntries(lines.map((l) => [l.code, l]));
    // 2 unbilled bottles × ₹180 = ₹360 cash; beer GST 12% is inside it
    expect(by.CASH.debit).toBe('360.00');
    expect(by.SALES.credit).toBe('321.43');
    expect(by.OUTPUT_GST.credit).toBe('38.57');

    // re-open: stock and books both go back
    const un = await inject('POST', `/counter-sheets/sheet/${janataSheet}/unpost`, ctx.auth('manager'));
    expect(un.statusCode, un.body).toBe(200);
    expect(await counters(beerId)).toMatchObject({ total: 96, JANATA: 16, WALK_IN: 80 });
    expect(await vouchers('COUNTER_SHEET')).toHaveLength(0);
    const reversal = await ctx.db.select().from(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.sourceType, 'COUNTER_SHEET_VOID'));
    expect(reversal).toHaveLength(1);

    // posting again books it once more (fresh voucher)
    expect((await inject('POST', `/counter-sheets/sheet/${janataSheet}/post`, ctx.auth('manager'))).statusCode).toBe(200);
    expect(await vouchers('COUNTER_SHEET')).toHaveLength(1);
    expect(await counters(beerId)).toMatchObject({ total: 94, JANATA: 14 });
  });

  it('the Walk-in sheet is unaffected by the Janata correction and posts without booking anything extra', async () => {
    const before = await ctx.db.select().from(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.sourceId, walkInSheet));
    const post = await inject('POST', `/counter-sheets/sheet/${walkInSheet}/post`, ctx.auth('manager'));
    expect(post.statusCode, post.body).toBe(200);
    const after = await ctx.db.select().from(ctx.schema.journalVouchers).where(eq(ctx.schema.journalVouchers.sourceId, walkInSheet));
    expect(after.length - before.length).toBeLessThanOrEqual(1);   // only if Walk-in sold bottles outside the POS today
    expect(await stockRow(beerId)).toBe(94);
  });
});

describe('dividing the stock (inventory is the source of truth)', () => {
  it('an approved invoice lands in Walk-in; the owner then divides it between Walk-in and Janata, in either direction', async () => {
    const [whisky] = ctx.products;
    const types = (await inject('GET', `/sale-types/${ctx.branchId}`, ctx.auth('cashier'))).json() as { id: string; code: string }[];
    const janata = types.find((t) => t.code === 'JANATA')!.id;
    await inject('PUT', `/sale-types/${ctx.branchId}/prices`, ctx.auth('manager'), { prices: [{ productId: whisky.id, saleTypeId: janata, price: '900.00' }] });
    const before = await counters(whisky.id);                       // whatever the earlier tests left: Walk-in + Janata = total

    // goods received on an invoice all arrive in the shop total / Walk-in counter
    const draft = await inject('POST', `/invoices/${ctx.branchId}`, ctx.auth('manager'), {
      supplierName: 'Depot', invoiceNumber: 'SPLIT-1', totalAmount: '8000.00',
      items: [{ productId: whisky.id, rawDescription: 'Whisky', quantity: 10, costPrice: '800.00', mrp: '1000.00' }],
    });
    expect((await inject('POST', `/invoices/detail/${draft.json().invoice.id}/approve`, ctx.auth('manager'))).statusCode).toBe(200);
    const received = await counters(whisky.id);
    expect(received.total).toBe(before.total + 10);
    expect(received.WALK_IN).toBe(before.WALK_IN + 10);
    expect(received.JANATA).toBe(before.JANATA);                     // nothing goes to Janata by itself

    // divide: Janata should hold 40 → the difference comes out of Walk-in; the total is unchanged
    const set = await inject('PUT', `/sale-types/${ctx.branchId}/allocation`, ctx.auth('manager'), { allocations: [{ productId: whisky.id, saleTypeId: janata, quantity: 40 }] });
    expect(set.statusCode, set.body).toBe(200);
    const split = await counters(whisky.id);
    expect(split).toMatchObject({ total: received.total, JANATA: 40, WALK_IN: received.total - 40 });

    // take some back to Walk-in
    expect((await inject('PUT', `/sale-types/${ctx.branchId}/allocation`, ctx.auth('manager'), { allocations: [{ productId: whisky.id, saleTypeId: janata, quantity: 15 }] })).statusCode).toBe(200);
    expect(await counters(whisky.id)).toMatchObject({ total: received.total, JANATA: 15, WALK_IN: received.total - 15 });

    // every move is audited
    const moves = await ctx.db.select().from(ctx.schema.stockAudit).where(and(eq(ctx.schema.stockAudit.productId, whisky.id), eq(ctx.schema.stockAudit.reason, 'TYPE_TRANSFER')));
    expect(moves.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses more than the shop has, a type without a price, the default type, and a cashier', async () => {
    const [whisky] = ctx.products;
    const types = (await inject('GET', `/sale-types/${ctx.branchId}`, ctx.auth('cashier'))).json() as { id: string; code: string }[];
    const janata = types.find((t) => t.code === 'JANATA')!.id;
    const walkIn = types.find((t) => t.code === 'WALK_IN')!.id;
    const total = (await counters(whisky.id)).total;
    const put = (allocations: unknown[], h = ctx.auth('manager')) => inject('PUT', `/sale-types/${ctx.branchId}/allocation`, h, { allocations });

    expect((await put([{ productId: whisky.id, saleTypeId: janata, quantity: total + 1 }])).statusCode).toBe(422);
    expect((await counters(whisky.id)).JANATA).toBe(15);             // all or nothing
    // a product that has stock but no Janata price cannot be handed to Janata
    const [fresh] = await ctx.db.insert(ctx.schema.products).values({
      name: 'Unpriced Gin 750ml', brand: 'UG', sku: 'UG750', mrp: '500.00', categoryId: ctx.products[0].categoryId, volumeMl: 750, packQuantity: 12,
    }).returning();
    await ctx.db.insert(ctx.schema.stock).values({ branchId: ctx.branchId, productId: fresh.id, quantity: 10 });
    const nopr = await put([{ productId: fresh.id, saleTypeId: janata, quantity: 1 }]);
    expect(nopr.statusCode).toBe(422);
    expect(nopr.body).toMatch(/Set a Janata price/);
    expect((await put([{ productId: whisky.id, saleTypeId: walkIn, quantity: 5 }])).statusCode).toBe(422);
    expect((await put([{ productId: whisky.id, saleTypeId: janata, quantity: 5 }], ctx.auth('cashier'))).statusCode).toBe(403);
  });
});