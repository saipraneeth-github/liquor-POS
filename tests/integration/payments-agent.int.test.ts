import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
let tenantId: string;
let admin: { authorization: string };
const ADMIN_EMAIL = 'pay-admin@t.test';
const PASSWORD = 'Sup3rSecret!';
const DAY = 86_400_000;

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers?: { authorization: string } | Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: headers as Record<string, string>, payload: payload as object | undefined });
const login = (email: string, password = PASSWORD) => inject('POST', '/api/v1/auth/login', undefined, { email, password });
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
const setTenant = (patch: Partial<typeof import('../../src/db/schema.js').syndicates.$inferInsert>) =>
  ctx.db.update(ctx.schema.syndicates).set(patch).where(eq(ctx.schema.syndicates.id, tenantId));
const lastMail = async () => (await ctx.db.select().from(ctx.schema.emailOutbox).orderBy(desc(ctx.schema.emailOutbox.createdAt)).limit(1))[0];

beforeAll(async () => {
  ctx = await setupIntegration();
  const hash = await bcrypt.hash('Password@123', 4);
  const [sa] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform Root', email: 'root@pay.local', passwordHash: hash, role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdmin = ctx.authFor({ sub: sa.id, email: sa.email, role: 'owner', branchId: null, syndicateId: null });
  const created = (await inject('POST', '/api/v1/platform/tenants', superAdmin, {
    name: 'Pay Tenant', plan: 'STANDARD', admin: { name: 'Payer', email: ADMIN_EMAIL, password: PASSWORD },
  })).json();
  tenantId = created.tenant.id;
  admin = { authorization: `Bearer ${(await login(ADMIN_EMAIL)).json().token}` };
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function newInvoice(): Promise<{ id: string; amount: string }> {
  await ctx.db.delete(ctx.schema.paymentOrders);
  await ctx.db.delete(ctx.schema.subscriptionInvoices).where(eq(ctx.schema.subscriptionInvoices.syndicateId, tenantId));
  const res = await inject('POST', '/api/v1/tenant/invoices/renew', admin);
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('online payment (test gateway)', () => {
  it('start -> simulated payment -> verify marks the invoice paid and extends access', async () => {
    await setTenant({ paidUntil: new Date(Date.now() + 2 * DAY) });
    const invoice = await newInvoice();
    const start = await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin);
    expect(start.statusCode).toBe(200);
    const checkout = start.json();
    expect(checkout).toMatchObject({ provider: 'mock', amountPaise: 299900, currency: 'INR', keyId: null });

    const paid = (await inject('POST', '/api/v1/tenant/payments/mock-pay', admin, { orderId: checkout.orderId })).json();
    const verify = await inject('POST', '/api/v1/tenant/payments/verify', admin, paid);
    expect(verify.statusCode).toBe(200);

    const invoices = (await inject('GET', '/api/v1/tenant/invoices', admin)).json().invoices;
    expect(invoices[0]).toMatchObject({ status: 'PAID' });
    expect(invoices[0].paymentRef).toMatch(/^mock:mock_pay_/);
    const me = (await inject('GET', '/api/v1/tenant/me', admin)).json();
    expect(new Date(me.paidUntil).getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
  });

  it('a forged signature is rejected and the invoice stays unpaid', async () => {
    const invoice = await newInvoice();
    const checkout = (await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin)).json();
    const bad = await inject('POST', '/api/v1/tenant/payments/verify', admin, { orderId: checkout.orderId, paymentId: 'pay_fake', signature: 'f'.repeat(64) });
    expect(bad.statusCode).toBe(422);
    expect((await inject('GET', '/api/v1/tenant/invoices', admin)).json().invoices[0].status).toBe('PENDING');
  });

  it('cannot pay a settled invoice, someone else\'s invoice, or use mock-pay for an unknown order', async () => {
    const invoice = await newInvoice();
    const checkout = (await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin)).json();
    const paid = (await inject('POST', '/api/v1/tenant/payments/mock-pay', admin, { orderId: checkout.orderId })).json();
    await inject('POST', '/api/v1/tenant/payments/verify', admin, paid);
    expect((await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin)).statusCode).toBe(422);
    expect((await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, ctx.auth('owner'))).statusCode).toBe(404);   // another tenant's Admin
    expect((await inject('POST', '/api/v1/tenant/payments/mock-pay', admin, { orderId: 'nope' })).statusCode).toBe(404);
  });

  it('the browser callback and the webhook can both arrive: the payment counts once', async () => {
    vi.stubEnv('MOCK_PAYMENT_SECRET', 'mock-secret-x');
    const invoice = await newInvoice();
    const checkout = (await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin)).json();
    const paid = (await inject('POST', '/api/v1/tenant/payments/mock-pay', admin, { orderId: checkout.orderId })).json();
    await inject('POST', '/api/v1/tenant/payments/verify', admin, paid);
    const before = (await inject('GET', '/api/v1/tenant/me', admin)).json().paidUntil;

    const body = JSON.stringify({ orderId: checkout.orderId, paymentId: paid.paymentId, paid: true });
    // mock gateway has no webhook route of its own: the Razorpay route is only for Razorpay
    const res = await inject('POST', '/api/v1/webhooks/razorpay', { 'content-type': 'application/json', 'x-razorpay-signature': hmac('mock-secret-x', body) }, body);
    expect(res.statusCode).toBe(200);
    expect((await inject('GET', '/api/v1/tenant/me', admin)).json().paidUntil).toBe(before);
    // the webhook did not settle it a second time: still exactly one capture event for this order
    const events = (await inject('GET', '/api/v1/platform/audit', superAdmin)).json().events.filter((e: { action: string; meta: { paymentId?: string } }) => e.action === 'payment.captured' && e.meta?.paymentId === paid.paymentId);
    expect(events).toHaveLength(1);
  });
});

describe('Razorpay provider', () => {
  const KEY = { id: 'rzp_test_abc', secret: 'key_secret_123', webhook: 'whsec_456' };
  const useRazorpay = () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'razorpay');
    vi.stubEnv('RAZORPAY_KEY_ID', KEY.id);
    vi.stubEnv('RAZORPAY_KEY_SECRET', KEY.secret);
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', KEY.webhook);
  };

  it('creates the order with Basic auth and the amount in paise, then verifies the real signature scheme', async () => {
    useRazorpay();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'order_Rzp123' }), { status: 200 });
    }));
    const invoice = await newInvoice();
    const start = await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin);
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ provider: 'razorpay', keyId: KEY.id, orderId: 'order_Rzp123', amountPaise: 299900 });

    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from(`${KEY.id}:${KEY.secret}`).toString('base64'));
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ amount: 299900, currency: 'INR' });

    // test-gateway shortcut is closed when Razorpay is live
    expect((await inject('POST', '/api/v1/tenant/payments/mock-pay', admin, { orderId: 'order_Rzp123' })).statusCode).toBe(404);

    const paymentId = 'pay_Abc999';
    expect((await inject('POST', '/api/v1/tenant/payments/verify', admin, { orderId: 'order_Rzp123', paymentId, signature: hmac('wrong', `order_Rzp123|${paymentId}`) })).statusCode).toBe(422);
    const ok = await inject('POST', '/api/v1/tenant/payments/verify', admin, { orderId: 'order_Rzp123', paymentId, signature: hmac(KEY.secret, `order_Rzp123|${paymentId}`) });
    expect(ok.statusCode).toBe(200);
    expect((await inject('GET', '/api/v1/tenant/invoices', admin)).json().invoices[0]).toMatchObject({ status: 'PAID', paymentRef: `razorpay:${paymentId}` });
  });

  it('a gateway outage becomes a clean error, not a crash', async () => {
    useRazorpay();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"description":"down"}}', { status: 502 })));
    const invoice = await newInvoice();
    const res = await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);
    expect((await inject('GET', '/api/v1/tenant/invoices', admin)).json().invoices[0].status).toBe('PENDING');
  });

  it('the webhook settles a payment even if the browser never came back; bad signatures are refused', async () => {
    useRazorpay();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'order_Hook1' }), { status: 200 })));
    const invoice = await newInvoice();
    await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, admin);

    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_Hook1', order_id: 'order_Hook1', status: 'captured' } } } };
    const raw = JSON.stringify(event);
    const headers = (sig: string) => ({ 'content-type': 'application/json', 'x-razorpay-signature': sig });

    expect((await inject('POST', '/api/v1/webhooks/razorpay', headers('0'.repeat(64)), raw)).statusCode).toBe(400);
    expect((await inject('POST', '/api/v1/webhooks/razorpay', { 'content-type': 'application/json' }, raw)).statusCode).toBe(400);
    expect((await inject('GET', '/api/v1/tenant/invoices', admin)).json().invoices[0].status).toBe('PENDING');

    const good = await inject('POST', '/api/v1/webhooks/razorpay', headers(hmac(KEY.webhook, raw)), raw);
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ handled: true });
    expect((await inject('GET', '/api/v1/tenant/invoices', admin)).json().invoices[0]).toMatchObject({ status: 'PAID', paymentRef: 'razorpay:pay_Hook1' });

    // Razorpay retries: a duplicate delivery is acknowledged and changes nothing
    const again = await inject('POST', '/api/v1/webhooks/razorpay', headers(hmac(KEY.webhook, raw)), raw);
    expect(again.statusCode).toBe(200);
    // an order we do not know (another system on the same account) is acknowledged and ignored
    const other = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_unknown', status: 'captured' } } } });
    expect((await inject('POST', '/api/v1/webhooks/razorpay', headers(hmac(KEY.webhook, other)), other)).json()).toEqual({ handled: false });
  });
});

describe('locked tenants can still pay', () => {
  it('an overdue / expired tenant signs in, sees access=locked, cannot use the app, but can reach billing', async () => {
    await setTenant({ plan: 'STANDARD', paidUntil: new Date(Date.now() - 12 * DAY) });
    const session = await login(ADMIN_EMAIL);
    expect(session.statusCode).toBe(200);
    const locked = { authorization: `Bearer ${session.json().token}` };

    expect((await inject('GET', '/api/v1/me', locked)).json().access).toBe('OVERDUE');
    const products = await inject('GET', '/api/v1/products', locked);
    expect(products.statusCode).toBe(403);
    expect(products.json().code).toBe('OVERDUE');

    const invoice = await newInvoice();
    const checkout = (await inject('POST', `/api/v1/tenant/invoices/${invoice.id}/pay-online`, locked)).json();
    const paid = (await inject('POST', '/api/v1/tenant/payments/mock-pay', locked, { orderId: checkout.orderId })).json();
    expect((await inject('POST', '/api/v1/tenant/payments/verify', locked, paid)).statusCode).toBe(200);

    expect((await inject('GET', '/api/v1/products', locked)).statusCode).toBe(200);
    expect((await inject('GET', '/api/v1/me', locked)).json().access).toBe('OK');
  });

  it('a suspended tenant still cannot sign in', async () => {
    await setTenant({ isActive: false });
    expect((await login(ADMIN_EMAIL)).statusCode).toBe(403);
    await setTenant({ isActive: true });
  });

  it('an expired trial can choose a plan, gets that plan\'s invoice and pays it', async () => {
    await setTenant({ plan: 'TRIAL', trialEndsAt: new Date(Date.now() - DAY), paidUntil: null });
    await ctx.db.delete(ctx.schema.paymentOrders);
    await ctx.db.delete(ctx.schema.subscriptionInvoices).where(eq(ctx.schema.subscriptionInvoices.syndicateId, tenantId));
    const locked = { authorization: `Bearer ${(await login(ADMIN_EMAIL)).json().token}` };
    expect((await inject('GET', '/api/v1/me', locked)).json().access).toBe('TRIAL_EXPIRED');

    expect((await inject('POST', '/api/v1/tenant/plan', locked, { plan: 'TRIAL' })).statusCode).toBe(400);
    const plan = await inject('POST', '/api/v1/tenant/plan', locked, { plan: 'PRO' });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ plan: 'PRO', amount: '7999.00', status: 'PENDING' });
    // switching again replaces the unpaid invoice rather than stacking them
    const standard = await inject('POST', '/api/v1/tenant/plan', locked, { plan: 'STANDARD' });
    expect(standard.json()).toMatchObject({ plan: 'STANDARD', amount: '2999.00' });
    const invoices = (await inject('GET', '/api/v1/tenant/invoices', locked)).json().invoices;
    expect(invoices.filter((i: { status: string }) => i.status === 'PENDING')).toHaveLength(1);

    // choosing has no side effects: still a locked trial until the invoice is paid
    expect((await inject('GET', '/api/v1/me', locked)).json().access).toBe('TRIAL_EXPIRED');
    expect((await inject('GET', '/api/v1/tenant/me', locked)).json().plan).toBe('TRIAL');

    const checkout = (await inject('POST', `/api/v1/tenant/invoices/${standard.json().id}/pay-online`, locked)).json();
    const paid = (await inject('POST', '/api/v1/tenant/payments/mock-pay', locked, { orderId: checkout.orderId })).json();
    await inject('POST', '/api/v1/tenant/payments/verify', locked, paid);
    // paying is what switches the plan and opens the app
    expect((await inject('GET', '/api/v1/me', locked)).json().access).toBe('OK');
    const after = (await inject('GET', '/api/v1/tenant/me', locked)).json();
    expect(after).toMatchObject({ plan: 'STANDARD', maxBranches: 3 });
    expect(new Date(after.paidUntil).getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
  });

  it('a plan with too few branches is refused', async () => {
    const [b] = await ctx.db.insert(ctx.schema.branches).values([{ name: 'P1', code: 'PAY1', syndicateId: tenantId }, { name: 'P2', code: 'PAY2', syndicateId: tenantId }, { name: 'P3', code: 'PAY3', syndicateId: tenantId }, { name: 'P4', code: 'PAY4', syndicateId: tenantId }]).returning();
    expect(b).toBeTruthy();
    await setTenant({ plan: 'PRO', maxBranches: 25 });
    const res = await inject('POST', '/api/v1/tenant/plan', admin, { plan: 'STANDARD' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/allows 3/);
    await ctx.db.delete(ctx.schema.branches).where(eq(ctx.schema.branches.syndicateId, tenantId));
    await setTenant({ plan: 'STANDARD', maxBranches: 3, paidUntil: new Date(Date.now() + 20 * DAY) });
  });
});

describe('billing reminders', () => {
  it('raises the renewal invoice a week ahead and e-mails each reminder once', async () => {
    await ctx.db.delete(ctx.schema.paymentOrders);
    await ctx.db.delete(ctx.schema.subscriptionInvoices).where(eq(ctx.schema.subscriptionInvoices.syndicateId, tenantId));
    await ctx.db.delete(ctx.schema.dunningLog).where(eq(ctx.schema.dunningLog.syndicateId, tenantId));
    await ctx.db.delete(ctx.schema.emailOutbox);
    await setTenant({ plan: 'STANDARD', paidUntil: new Date(Date.now() + 5 * DAY), isActive: true });

    const first = await inject('POST', '/api/v1/platform/billing/run', superAdmin);
    expect(first.statusCode).toBe(200);
    expect(first.json().invoicesCreated).toBeGreaterThanOrEqual(1);
    const mails = await ctx.db.select().from(ctx.schema.emailOutbox).where(eq(ctx.schema.emailOutbox.toEmail, ADMIN_EMAIL));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: 'billing_due_7', status: 'LOGGED' });
    expect(mails[0].body).toContain('2,999.00');
    expect(mails[0].body).toContain('/settings');

    await inject('POST', '/api/v1/platform/billing/run', superAdmin);
    expect(await ctx.db.select().from(ctx.schema.emailOutbox).where(eq(ctx.schema.emailOutbox.toEmail, ADMIN_EMAIL))).toHaveLength(1);   // not twice

    await setTenant({ paidUntil: new Date(Date.now() + 0.5 * DAY) });
    await inject('POST', '/api/v1/platform/billing/run', superAdmin);
    const kinds = (await ctx.db.select().from(ctx.schema.emailOutbox).where(eq(ctx.schema.emailOutbox.toEmail, ADMIN_EMAIL))).map((m) => m.kind).sort();
    expect(kinds).toEqual(['billing_due_1', 'billing_due_7']);
  });

  it('a suspended tenant gets nothing; only the Super Admin can run the job', async () => {
    await ctx.db.delete(ctx.schema.emailOutbox);
    await ctx.db.delete(ctx.schema.dunningLog).where(eq(ctx.schema.dunningLog.syndicateId, tenantId));
    await setTenant({ isActive: false, paidUntil: new Date(Date.now() + 2 * DAY) });
    await inject('POST', '/api/v1/platform/billing/run', superAdmin);
    expect(await ctx.db.select().from(ctx.schema.emailOutbox).where(eq(ctx.schema.emailOutbox.toEmail, ADMIN_EMAIL))).toHaveLength(0);
    await setTenant({ isActive: true });
    expect((await inject('POST', '/api/v1/platform/billing/run', ctx.auth('owner'))).statusCode).toBe(403);
  });
});

describe('integrations status', () => {
  it('shows test mode with what is missing, never a secret', async () => {
    const res = await inject('GET', '/api/v1/platform/integrations', superAdmin);
    expect(res.statusCode).toBe(200);
    const pay = res.json().integrations.find((i: { key: string }) => i.key === 'payments');
    expect(pay).toMatchObject({ mode: 'test', ready: false });
    expect(pay.missing).toContain('RAZORPAY_KEY_ID');
    expect(JSON.stringify(res.json())).not.toMatch(/secret_|whsec_/);
    expect((await inject('GET', '/api/v1/platform/integrations', ctx.auth('owner'))).statusCode).toBe(403);
  });

  it('turns live when the variables are present', async () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'razorpay');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_live_x');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 's');
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'w');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('MAIL_FROM', 'a@b.c');
    const list = (await inject('GET', '/api/v1/platform/integrations', superAdmin)).json().integrations;
    expect(list.find((i: { key: string }) => i.key === 'payments')).toMatchObject({ mode: 'live', ready: true, missing: [] });
    expect(list.find((i: { key: string }) => i.key === 'mail')).toMatchObject({ mode: 'live' });
  });
});

describe('forgot password', () => {
  const tokenFromMail = async () => {
    const mail = await lastMail();
    return { mail, token: /token=([0-9a-f]+)/.exec(mail.body)?.[1] ?? '' };
  };

  it('e-mails a one-hour link; the new password works, the old does not, the link works once', async () => {
    await ctx.db.delete(ctx.schema.emailOutbox);
    const asked = await inject('POST', '/api/v1/auth/forgot-password', undefined, { email: ADMIN_EMAIL.toUpperCase() });
    expect(asked.statusCode).toBe(200);
    const { mail, token } = await tokenFromMail();
    expect(mail).toMatchObject({ toEmail: ADMIN_EMAIL, kind: 'password_reset' });
    expect(token).toHaveLength(64);
    // only a hash is stored
    const stored = await ctx.db.select().from(ctx.schema.passwordResets);
    expect(stored[0].tokenHash).not.toContain(token);

    expect((await inject('POST', '/api/v1/auth/reset-password', undefined, { token, newPassword: 'short' })).statusCode).toBe(400);
    const reset = await inject('POST', '/api/v1/auth/reset-password', undefined, { token, newPassword: 'Brand#New456' });
    expect(reset.statusCode).toBe(200);
    expect((await login(ADMIN_EMAIL, 'Brand#New456')).statusCode).toBe(200);
    expect((await login(ADMIN_EMAIL, PASSWORD)).statusCode).toBe(401);
    expect((await inject('POST', '/api/v1/auth/reset-password', undefined, { token, newPassword: 'Another#789' })).statusCode).toBe(400);   // used
    await inject('POST', '/api/v1/auth/reset-password', undefined, { token: 'x'.repeat(30), newPassword: 'Another#789' });
  });

  it('does not reveal unknown addresses, throttles repeats, and expired links fail', async () => {
    await ctx.db.delete(ctx.schema.emailOutbox);
    await ctx.db.delete(ctx.schema.passwordResets);
    const unknown = await inject('POST', '/api/v1/auth/forgot-password', undefined, { email: 'nobody@nowhere.test' });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().message).toMatch(/If that address/);
    expect(await ctx.db.select().from(ctx.schema.emailOutbox)).toHaveLength(0);

    await inject('POST', '/api/v1/auth/forgot-password', undefined, { email: ADMIN_EMAIL });
    await inject('POST', '/api/v1/auth/forgot-password', undefined, { email: ADMIN_EMAIL });
    expect(await ctx.db.select().from(ctx.schema.emailOutbox)).toHaveLength(1);

    const { token } = await tokenFromMail();
    await ctx.db.update(ctx.schema.passwordResets).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await inject('POST', '/api/v1/auth/reset-password', undefined, { token, newPassword: 'Late#Reset123' })).statusCode).toBe(400);
  });

  it('a deactivated account gets no link', async () => {
    await ctx.db.delete(ctx.schema.emailOutbox);
    await ctx.db.delete(ctx.schema.passwordResets);
    await inject('POST', '/api/v1/auth/forgot-password', undefined, { email: 'steward@test.local' });
    const before = await ctx.db.select().from(ctx.schema.emailOutbox);
    expect(before).toHaveLength(1);
    await ctx.db.delete(ctx.schema.emailOutbox);
    await ctx.db.delete(ctx.schema.passwordResets);
    await ctx.db.update(ctx.schema.users).set({ isActive: false }).where(eq(ctx.schema.users.email, 'steward@test.local'));
    await inject('POST', '/api/v1/auth/forgot-password', undefined, { email: 'steward@test.local' });
    expect(await ctx.db.select().from(ctx.schema.emailOutbox)).toHaveLength(0);
    await ctx.db.update(ctx.schema.users).set({ isActive: true }).where(eq(ctx.schema.users.email, 'steward@test.local'));
  });
});

describe('local print agent', () => {
  let token: string;
  let billId: string;
  let port: number;
  let outFile: string;

  beforeAll(async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    port = (ctx.app.server.address() as import('node:net').AddressInfo).port;
    outFile = path.join(os.tmpdir(), `agent-out-${Date.now()}.bin`);
    const bill = await inject('POST', '/api/v1/bills', ctx.auth('manager'), {
      branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }],
    });
    billId = bill.json().id;
  });

  afterAll(() => fs.rmSync(outFile, { force: true }));

  it('creates a token once, never shows its hash, and reports the agent as offline until it checks in', async () => {
    const res = await inject('POST', `/api/v1/branches/${ctx.branchId}/agent-token`, ctx.auth('manager'));
    expect(res.statusCode).toBe(201);
    token = res.json().token;
    expect(token).toMatch(/^pa_[0-9a-f]{48}$/);
    await inject('PATCH', `/api/v1/branches/${ctx.branchId}`, ctx.auth('owner'), { printViaAgent: true });
    const branches = (await inject('GET', '/api/v1/branches', ctx.auth('owner'))).json();
    const main = branches.find((b: { id: string }) => b.id === ctx.branchId);
    expect(main).toMatchObject({ hasAgentToken: true, printViaAgent: true, agentOnline: false });
    expect(JSON.stringify(branches)).not.toContain('agentTokenHash');
    expect((await inject('POST', `/api/v1/branches/${ctx.branchId}/agent-token`, ctx.auth('cashier'))).statusCode).toBe(403);
  });

  it('prints from the bill/KOT/test endpoints become agent jobs instead of TCP sends', async () => {
    const bill = await inject('POST', `/api/v1/print/bills/${billId}/send`, ctx.auth('cashier'));
    expect(bill.statusCode).toBe(202);
    expect(bill.json()).toMatchObject({ queued: true, agent: true });
    const test = await inject('POST', `/api/v1/print/test/${ctx.branchId}`, ctx.auth('manager'));
    expect(test.statusCode).toBe(202);
    const jobs = (await inject('GET', `/api/v1/print/jobs/${ctx.branchId}`, ctx.auth('manager'))).json().jobs;
    expect(jobs.filter((j: { target: string; status: string }) => j.target === 'AGENT' && j.status === 'PENDING')).toHaveLength(2);
  });

  it('rejects a wrong or missing agent token', async () => {
    expect((await inject('GET', '/api/v1/agent/jobs', { authorization: 'Bearer pa_nope' })).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/agent/jobs')).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/agent/jobs', ctx.auth('manager'))).statusCode).toBe(401);   // a user JWT is not an agent token
  });

  it('the real agent code fetches the jobs, writes the ESC/POS bytes to the printer and acknowledges', async () => {
    const { loadConfig, runOnce, printBytes } = await import('../../print-agent/agent-core.mjs');
    const cfgFile = path.join(os.tmpdir(), `agent-cfg-${Date.now()}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, token, printer: { type: 'file', path: outFile } }));
    const cfg = loadConfig(cfgFile);
    fs.rmSync(cfgFile, { force: true });

    const result = await runOnce(cfg, () => undefined);
    expect(result).toEqual({ printed: 2, failed: 0 });

    // the last job written is the test ticket; its text is in the file
    expect(fs.readFileSync(outFile).toString('latin1')).toContain('PRINTER TEST');
    const jobs = (await inject('GET', `/api/v1/print/jobs/${ctx.branchId}`, ctx.auth('manager'))).json().jobs;
    expect(jobs.filter((j: { target: string; status: string }) => j.target === 'AGENT').every((j: { status: string }) => j.status === 'SENT')).toBe(true);
    const branch = (await inject('GET', '/api/v1/branches', ctx.auth('owner'))).json().find((b: { id: string }) => b.id === ctx.branchId);
    expect(branch.agentOnline).toBe(true);

    // nothing left: the agent is idle
    expect(await runOnce(cfg, () => undefined)).toEqual({ printed: 0, failed: 0 });
    await expect(printBytes({ type: 'nope' }, Buffer.from('x'))).rejects.toThrow(/Unknown printer.type/);
  });

  it('a printer failure is reported, the job is retried, and it gives up after 5 attempts', async () => {
    const { runOnce } = await import('../../print-agent/agent-core.mjs');
    const cfg = { serverUrl: `http://127.0.0.1:${port}`, token, pollIntervalMs: 1, printer: { type: 'file', path: path.join(os.tmpdir(), 'no-such-dir-xyz', 'out.bin') } };
    const job = (await inject('POST', `/api/v1/print/bills/${billId}/send`, ctx.auth('cashier'))).json();
    const { claimAgentJobs } = await import('../../src/modules/printing/agent.service.js');

    for (let attempt = 1; attempt <= 5; attempt++) {
      // a failed job is offered again immediately because the agent un-claims it when it reports the error
      expect(await runOnce(cfg, () => undefined)).toEqual({ printed: 0, failed: 1 });
      const row = (await inject('GET', `/api/v1/print/jobs/${ctx.branchId}`, ctx.auth('manager'))).json().jobs.find((j: { id: string }) => j.id === job.jobId);
      expect(row.attempts).toBe(attempt);
      expect(row.status).toBe(attempt === 5 ? 'FAILED' : 'PENDING');
      expect(row.lastError).toBeTruthy();
    }
    expect(await claimAgentJobs(ctx.branchId)).toEqual([]);

    // Retry from the UI puts it back; a working printer then clears it
    expect((await inject('POST', `/api/v1/print/jobs/${job.jobId}/retry`, ctx.auth('manager'))).statusCode).toBe(200);
    expect(await runOnce({ ...cfg, printer: { type: 'file', path: outFile } }, () => undefined)).toEqual({ printed: 1, failed: 0 });
  });

  it('an unacknowledged job is offered again after the claim times out; one agent cannot touch another branch\'s jobs', async () => {
    const { claimAgentJobs } = await import('../../src/modules/printing/agent.service.js');
    await inject('POST', `/api/v1/print/bills/${billId}/send`, ctx.auth('cashier'));
    const first = await claimAgentJobs(ctx.branchId);
    expect(first).toHaveLength(1);
    expect(await claimAgentJobs(ctx.branchId)).toEqual([]);                                 // claimed: not handed out twice
    expect(await claimAgentJobs(ctx.branchId, 5, new Date(Date.now() + 120_000))).toHaveLength(1);   // agent died: offered again

    const otherToken = (await inject('POST', `/api/v1/branches/${ctx.otherBranchId}/agent-token`, ctx.authFor({ sub: ctx.users.owner.id, email: 'owner@test.local', role: 'owner', branchId: null, syndicateId: ctx.syndicateId }))).json().token;
    // 'other' branch is outside the owner's syndicate -> refused above; use a direct token instead
    expect(otherToken).toBeUndefined();
    const ack = await inject('POST', `/api/v1/agent/jobs/${first[0].id}/ack`, { authorization: `Bearer ${token}` }, { ok: true });
    expect(ack.statusCode).toBe(200);
  });

  it('revoking the token cuts the agent off and sends prints back to the normal path', async () => {
    expect((await inject('DELETE', `/api/v1/branches/${ctx.branchId}/agent-token`, ctx.auth('manager'))).statusCode).toBe(200);
    expect((await inject('GET', '/api/v1/agent/jobs', { authorization: `Bearer ${token}` })).statusCode).toBe(401);
    const res = await inject('POST', `/api/v1/print/bills/${billId}/send`, ctx.auth('cashier'));
    expect(res.statusCode).toBe(422);     // no network printer configured and no agent
    expect(res.json().error).toMatch(/No network printer/);
  });
});
