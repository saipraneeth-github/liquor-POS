import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
let webhook: http.Server;
const hooked: string[] = [];

beforeAll(async () => {
  ctx = await setupIntegration();
  const [sa] = await ctx.db.insert(ctx.schema.users).values({ name: 'Platform Root', email: 'root@test.local', passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner' }).returning();
  superAdmin = ctx.authFor({ sub: sa.id, email: sa.email, role: 'owner', branchId: null, syndicateId: null });
  // a listener that records what the error webhook is sent
  webhook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooked.push(b); res.end('ok'); }); });
  await new Promise<void>((r) => webhook.listen(0, '127.0.0.1', r));
  process.env.ERROR_WEBHOOK_URL = `http://127.0.0.1:${(webhook.address() as { port: number }).port}/hook`;
}, 120_000);
afterAll(async () => { delete process.env.ERROR_WEBHOOK_URL; webhook?.close(); await ctx?.app.close(); });

const report = (payload: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/client-errors', headers, payload: payload as never });
const rows = () => ctx.db.select().from(ctx.schema.errorEvents);
const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 40 && !cond(); i++) await new Promise((r) => setTimeout(r, 50)); };

describe('browser errors', () => {
  it('stores one row per distinct error and counts repeats', async () => {
    const e = { message: 'Cannot read properties of undefined (reading "total")', stack: 'TypeError: x\n    at render (https://app/assets/POS-abc.js:10:5)', url: '/pos?branchId=secret' };
    expect((await report(e)).statusCode).toBe(204);
    expect((await report({ ...e, stack: e.stack.replace(':10:5', ':99:7') })).statusCode).toBe(204);   // same bug, different line
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ source: 'BROWSER', occurrences: 2, route: '/pos' });   // the query string is dropped
    expect(all[0].userId).toBeNull();
  });

  it('links the report to the signed-in user, scrubs personal data, and caps the size', async () => {
    const res = await report({ message: 'Failed for ravi.k@shop.example.in phone 9876543210', url: '/customers' }, ctx.auth('cashier'));
    expect(res.statusCode).toBe(204);
    const row = (await rows()).find((r) => r.message.includes('[email]'))!;
    expect(row.message).toBe('Failed for [email] phone [number]');
    expect(row.userId).toBe(ctx.users.cashier.id);
    expect((await report({ message: '' })).statusCode).toBe(400);
    expect((await report({ message: 'x'.repeat(600) })).statusCode).toBe(400);
    expect((await report({ message: 'big', stack: 'y'.repeat(20_000) })).statusCode).toBe(413);
  });
});

describe('server errors', () => {
  it('a new error rings the webhook once; a repeat only counts; a resolved error reopens', async () => {
    const { captureError } = await import('../../src/modules/errors/error-tracker.js');
    const e = { source: 'SERVER' as const, message: 'relation "x" does not exist', stack: 'Error: x\n    at query (D:/app/db.ts:3:1)', route: '/api/v1/bills', method: 'POST', status: 500 };
    const before = hooked.length;   // the browser errors above already rang it, once each
    expect(await captureError(e)).toBe(true);
    await waitFor(() => hooked.length > before);
    expect(JSON.parse(hooked[before]).text).toContain('New server error');
    expect(await captureError(e)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(hooked).toHaveLength(before + 1);   // a repeat does not ring again
    // nothing private travels: no query string, no e-mail
    expect(hooked.join(' ')).not.toContain('branchId=secret');
    expect(hooked.join(' ')).not.toContain('ravi.k@');

    const row = (await rows()).find((r) => r.source === 'SERVER')!;
    expect(row.occurrences).toBe(2);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/platform/errors/${row.id}/resolve`, headers: superAdmin })).statusCode).toBe(200);
    expect((await ctx.db.select().from(ctx.schema.errorEvents).where(eq(ctx.schema.errorEvents.id, row.id)))[0].resolvedAt).not.toBeNull();
    await captureError(e);
    expect((await ctx.db.select().from(ctx.schema.errorEvents).where(eq(ctx.schema.errorEvents.id, row.id)))[0]).toMatchObject({ resolvedAt: null, occurrences: 3 });
  });
});

describe('Super Admin view', () => {
  it('lists distinct errors, newest first, and nobody else can see them', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/errors', headers: superAdmin });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors.length).toBeGreaterThanOrEqual(3);
    expect(res.json().open).toBe(res.json().errors.length);
    const onlyServer = (await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/errors?source=SERVER', headers: superAdmin })).json().errors;
    expect(onlyServer.every((e: { source: string }) => e.source === 'SERVER')).toBe(true);

    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/errors', headers: ctx.auth('owner') })).statusCode).toBe(403);   // a business owner
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/errors', headers: ctx.auth('manager') })).statusCode).toBe(403);
  });
});
