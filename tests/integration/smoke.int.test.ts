import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

describe('integration harness', () => {
  it('serves /health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('logs in a seeded user', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'cashier@test.local', password: 'Password@123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('creates a bill end-to-end against the real schema', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/bills', headers: ctx.auth('cashier'),
      payload: { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 2 }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().total).toBe('2000.00');
  });
});
