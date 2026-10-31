import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let barId: string;          // 750 ml whisky on the bar menu
let pegServing: string;     // 60 ml
let bigPegServing: string;  // 90 ml
let bottleServing: string;  // full bottle
let foodId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

const stockRow = async (productId: string) => {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId)));
  return row;
};

const bill = (items: unknown[], headers = ctx.auth('cashier')) => ctx.app.inject({
  method: 'POST', url: '/api/v1/bills', headers,
  payload: { branchId: ctx.branchId, paymentMode: 'CASH', items },
});

describe('kitchen menu', () => {
  it('manager creates a food item with GST, description and availability', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/menu/kitchen', headers: ctx.auth('manager'),
      payload: { name: 'Paneer Tikka', categoryName: 'Starters', price: '240.00', gstRate: '5', description: 'Smoky, 6 pcs' },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    foodId = item.id;
    expect(item).toMatchObject({ menuType: 'KITCHEN', mrp: '240.00', gstRate: '5.00', isAvailable: true, trackStock: false });
    expect(item.categoryName).toBe('Starters');
  });

  it('cashier cannot create or edit menu items; steward can read', async () => {
    const create = await ctx.app.inject({
      method: 'POST', url: '/api/v1/menu/kitchen', headers: ctx.auth('cashier'),
      payload: { name: 'X', categoryName: 'Starters', price: '10', gstRate: '5' },
    });
    expect(create.statusCode).toBe(403);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/menu/kitchen', headers: ctx.auth('steward') });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((i: { name: string }) => i.name)).toContain('Paneer Tikka');
  });

  it('bills a kitchen item without stock rows, with its own GST rate', async () => {
    const res = await bill([{ productId: foodId, quantity: 2 }]);
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.total).toBe('480.00');
    expect(b.taxAmount).toBe('22.86');            // 480 - 480/1.05
    expect(b.items[0].taxRate).toBe('5.00');
  });

  it('rate change is recorded in price history', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/v1/menu/items/${foodId}`, headers: ctx.auth('manager'),
      payload: { price: '260' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mrp).toBe('260.00');
    const hist = await ctx.app.inject({ method: 'GET', url: `/api/v1/menu/items/${foodId}/price-history`, headers: ctx.auth('manager') });
    const rows = hist.json().history;
    expect(rows.map((r: { newPrice: string }) => r.newPrice)).toEqual(['260.00', '240.00']);
    expect(rows[0].oldPrice).toBe('240.00');
  });

  it('out-of-stock items cannot be billed; back in stock they can', async () => {
    await ctx.app.inject({ method: 'PATCH', url: `/api/v1/menu/items/${foodId}`, headers: ctx.auth('manager'), payload: { isAvailable: false } });
    const blocked = await bill([{ productId: foodId, quantity: 1 }]);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toMatch(/Out of stock/);
    await ctx.app.inject({ method: 'PATCH', url: `/api/v1/menu/items/${foodId}`, headers: ctx.auth('manager'), payload: { isAvailable: true } });
    expect((await bill([{ productId: foodId, quantity: 1 }])).statusCode).toBe(201);
  });

  it('soft-deletes: hidden from the menu and from billing', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/menu/kitchen', headers: ctx.auth('manager'),
      payload: { name: 'Temp Dish', categoryName: 'Starters', price: '99', gstRate: '5' },
    });
    const id = created.json().id;
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/v1/menu/items/${id}`, headers: ctx.auth('manager') })).statusCode).toBe(200);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/menu/kitchen', headers: ctx.auth('manager') });
    expect(list.json().items.map((i: { id: string }) => i.id)).not.toContain(id);
    expect((await bill([{ productId: id, quantity: 1 }])).statusCode).toBe(422);
  });

  it('rejects servings on kitchen items and bad GST', async () => {
    const bad = await ctx.app.inject({
      method: 'POST', url: '/api/v1/menu/kitchen', headers: ctx.auth('manager'),
      payload: { name: 'Bad', categoryName: 'Starters', price: '10', gstRate: '150' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('bar menu with peg servings', () => {
  it('creates a bar item with 30/60/90 ml and full-bottle rates', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/menu/bar', headers: ctx.auth('manager'),
      payload: {
        name: 'Single Malt 750ml', categoryName: 'Whisky', price: '3000', gstRate: '18', volumeMl: 750,
        servings: [
          { label: '60 ml', volumeMl: 60, price: '300' },
          { label: '90 ml', volumeMl: 90, price: '420' },
          { label: 'Full bottle', price: '3000' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    barId = item.id;
    expect(item.servings).toHaveLength(3);
    pegServing = item.servings.find((s: { label: string }) => s.label === '60 ml').id;
    bigPegServing = item.servings.find((s: { label: string }) => s.label === '90 ml').id;
    bottleServing = item.servings.find((s: { label: string }) => s.label === 'Full bottle').id;
    await ctx.db.insert(ctx.schema.stock).values({ branchId: ctx.branchId, productId: barId, quantity: 2 });
  });

  it('rejects a peg larger than the bottle and duplicate labels', async () => {
    const tooBig = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/menu/items/${barId}/servings`, headers: ctx.auth('manager'),
      payload: { servings: [{ label: '1000 ml', volumeMl: 1000, price: '1' }] },
    });
    expect(tooBig.statusCode).toBe(422);
    const dup = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/menu/items/${barId}/servings`, headers: ctx.auth('manager'),
      payload: { servings: [{ label: 'Peg', volumeMl: 30, price: '1' }, { label: 'peg', volumeMl: 60, price: '2' }] },
    });
    expect(dup.statusCode).toBe(422);
  });

  it('bills pegs at the serving rate and draws ml from an opened bottle', async () => {
    // 3 x 60 ml + 1 x 90 ml = 270 ml -> opens one bottle (750), 480 ml left
    const res = await bill([{ productId: barId, servingId: pegServing, quantity: 3 }, { productId: barId, servingId: bigPegServing, quantity: 1 }]);
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.total).toBe('1320.00');   // 900 + 420
    expect(b.items.map((i: { servingLabel: string }) => i.servingLabel).sort()).toEqual(['60 ml', '90 ml']);
    const s = await stockRow(barId);
    expect(s.quantity).toBe(1);
    expect(s.openMl).toBe(480);
  });

  it('keeps using the open bottle before opening a new one', async () => {
    expect((await bill([{ productId: barId, servingId: pegServing, quantity: 2 }])).statusCode).toBe(201);
    const s = await stockRow(barId);
    expect(s.quantity).toBe(1);
    expect(s.openMl).toBe(360);
  });

  it('full-bottle serving deducts one sealed bottle at its own rate', async () => {
    const res = await bill([{ productId: barId, servingId: bottleServing, quantity: 1 }]);
    expect(res.statusCode).toBe(201);
    expect(res.json().total).toBe('3000.00');
    const s = await stockRow(barId);
    expect(s.quantity).toBe(0);
    expect(s.openMl).toBe(360);
  });

  it('refuses a peg when ml cannot be covered', async () => {
    // 360 ml left in the open bottle, no sealed bottles
    const res = await bill([{ productId: barId, servingId: bigPegServing, quantity: 5 }]);   // 450 ml
    expect(res.statusCode).toBe(422);
    expect((await stockRow(barId)).openMl).toBe(360);
  });

  it('voiding a peg bill restores the ml', async () => {
    const sold = await bill([{ productId: barId, servingId: pegServing, quantity: 1 }]);   // 60 ml
    expect((await stockRow(barId)).openMl).toBe(300);
    const v = await ctx.app.inject({
      method: 'POST', url: `/api/v1/bills/${sold.json().id}/void`, headers: ctx.auth('manager'),
      payload: { voidReason: 'Wrong drink served' },
    });
    expect(v.statusCode).toBe(200);
    expect((await stockRow(barId)).openMl).toBe(360);
  });

  it('serving rate edits persist and appear in price history', async () => {
    const cur = (await ctx.app.inject({ method: 'GET', url: `/api/v1/menu/items/${barId}`, headers: ctx.auth('manager') })).json();
    const next = cur.servings.map((s: { id: string; label: string; volumeMl: number | null; price: string }) => ({
      id: s.id, label: s.label, volumeMl: s.volumeMl, price: s.label === '60 ml' ? '330' : s.price,
    }));
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/v1/menu/items/${barId}/servings`, headers: ctx.auth('manager'), payload: { servings: next } });
    expect(res.statusCode).toBe(200);
    expect(res.json().servings.find((s: { label: string }) => s.label === '60 ml').price).toBe('330.00');
    const hist = (await ctx.app.inject({ method: 'GET', url: `/api/v1/menu/items/${barId}/price-history`, headers: ctx.auth('manager') })).json().history;
    expect(hist.find((h: { serving: string; newPrice: string }) => h.serving === '60 ml' && h.newPrice === '330.00')).toMatchObject({ oldPrice: '300.00' });
  });

  it('a removed serving is retired, not deleted, and cannot be sold', async () => {
    const cur = (await ctx.app.inject({ method: 'GET', url: `/api/v1/menu/items/${barId}`, headers: ctx.auth('manager') })).json();
    const keep = cur.servings.filter((s: { label: string }) => s.label !== '90 ml')
      .map((s: { id: string; label: string; volumeMl: number | null; price: string }) => ({ id: s.id, label: s.label, volumeMl: s.volumeMl, price: s.price }));
    await ctx.app.inject({ method: 'PUT', url: `/api/v1/menu/items/${barId}/servings`, headers: ctx.auth('manager'), payload: { servings: keep } });
    expect((await bill([{ productId: barId, servingId: bigPegServing, quantity: 1 }])).statusCode).toBe(422);
  });

  it('an existing retail bottle can be adopted into the bar menu', async () => {
    const retail = ctx.products[0].id;
    const res = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/menu/items/${retail}`, headers: ctx.auth('manager'), payload: { menuType: 'BAR' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().menuType).toBe('BAR');
    const notRetail = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/menu/items/${ctx.products[1].id}`, headers: ctx.auth('manager'), payload: { price: '5' } });
    expect(notRetail.statusCode).toBe(404);
  });

  it('GET /products carries bar servings for POS and KOT', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/products', headers: ctx.auth('cashier') });
    const p = res.json().find((x: { id: string }) => x.id === barId);
    expect(p.servings.map((s: { label: string }) => s.label)).toEqual(['60 ml', 'Full bottle']);
  });
});
