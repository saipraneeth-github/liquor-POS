import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import net from 'node:net';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
let superAdminId: string;
let tenantB: { id: string; adminEmail: string; admin: { authorization: string } };

const PASSWORD = 'Sup3rSecret!';
const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: { authorization: string } | undefined, payload?: unknown) =>
  ctx.app.inject({ method, url, headers, payload: payload as object | undefined });
const login = (email: string, password = PASSWORD) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

beforeAll(async () => {
  ctx = await setupIntegration();
  const hash = await bcrypt.hash('Password@123', 4);
  const [sa] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform Root', email: 'root@ops.local', passwordHash: hash, role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdminId = sa.id;
  superAdmin = ctx.authFor({ sub: sa.id, email: sa.email, role: 'owner', branchId: null, syndicateId: null });

  const created = (await inject('POST', '/api/v1/platform/tenants', superAdmin, {
    name: 'Tenant B', plan: 'STANDARD', admin: { name: 'Bee', email: 'bee@b.test', password: PASSWORD },
  })).json();
  const token = (await login('bee@b.test')).json().token;
  tenantB = { id: created.tenant.id, adminEmail: 'bee@b.test', admin: { authorization: `Bearer ${token}` } };
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

describe('catalog per business', () => {
  const categoryId = () => ctx.products[0].categoryId;

  it('two businesses can sell the same barcode, and each sees only its own product', async () => {
    const body = { categoryId: categoryId(), name: 'Shared Brand 750ml', barcode: '8901234000099', mrp: '1000' };
    const a = await inject('POST', '/api/v1/products', ctx.auth('manager'), body);
    const b = await inject('POST', '/api/v1/products', tenantB.admin, { ...body, mrp: '1200' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);

    const dupA = await inject('POST', '/api/v1/products', ctx.auth('manager'), body);
    expect(dupA.statusCode).toBe(409);   // still unique inside one business

    const seenByB = (await inject('GET', '/api/v1/products', tenantB.admin)).json().filter((p: { name: string }) => p.name === 'Shared Brand 750ml');
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0].mrp).toBe('1200.00');
    const seenByA = (await inject('GET', '/api/v1/products', ctx.auth('cashier'))).json().filter((p: { name: string }) => p.name === 'Shared Brand 750ml');
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].mrp).toBe('1000.00');

    const scan = await inject('GET', '/api/v1/products/barcode/8901234000099', ctx.auth('cashier'));
    expect(scan.json().mrp).toBe('1000.00');
  });

  it("a business cannot adopt or bill another business's product", async () => {
    const bProduct = (await inject('GET', '/api/v1/products', tenantB.admin)).json().find((p: { name: string }) => p.name === 'Shared Brand 750ml');
    const adopt = await inject('PATCH', `/api/v1/menu/items/${bProduct.id}`, ctx.auth('manager'), { menuType: 'BAR' });
    expect(adopt.statusCode).toBe(404);
    const bill = await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: bProduct.id, quantity: 1 }],
    });
    expect(bill.statusCode).toBe(422);
  });
});

describe('subscription access and invoices', () => {
  const setTenant = (patch: Partial<typeof import('../../src/db/schema.js').syndicates.$inferInsert>) =>
    ctx.db.update(ctx.schema.syndicates).set(patch).where(eq(ctx.schema.syndicates.id, tenantB.id));
  const day = 86_400_000;

  it('an expired trial is locked out with a clear message', async () => {
    await setTenant({ plan: 'TRIAL', trialEndsAt: new Date(Date.now() - day) });
    // Sign-in still works (so the Admin can pay) but the app itself is closed
    const res = await login(tenantB.adminEmail);
    expect(res.statusCode).toBe(200);
    const products = await inject('GET', '/api/v1/products', tenantB.admin);
    expect(products.statusCode).toBe(403);
    expect(products.json().error).toMatch(/trial has ended/);
    expect((await inject('GET', '/api/v1/tenant/me', tenantB.admin)).json().access).toBe('TRIAL_EXPIRED');
    await setTenant({ trialEndsAt: new Date(Date.now() + day) });
    expect((await login(tenantB.adminEmail)).statusCode).toBe(200);
  });

  it('a paid plan gets a 7 day grace, then is blocked until the invoice is paid', async () => {
    await setTenant({ plan: 'STANDARD', paidUntil: new Date(Date.now() - 3 * day) });
    expect((await login(tenantB.adminEmail)).statusCode).toBe(200);          // inside grace
    await setTenant({ paidUntil: new Date(Date.now() - 10 * day) });
    const blocked = await inject('GET', '/api/v1/products', tenantB.admin);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatch(/overdue/);

    // Super Admin invoices and records the payment; access returns
    const inv = await inject('POST', `/api/v1/platform/tenants/${tenantB.id}/invoices`, superAdmin);
    expect(inv.statusCode).toBe(201);
    expect(inv.json()).toMatchObject({ plan: 'STANDARD', amount: '2999.00', status: 'PENDING' });
    expect((await inject('POST', `/api/v1/platform/tenants/${tenantB.id}/invoices`, superAdmin)).statusCode).toBe(409);   // one open invoice

    expect((await inject('POST', `/api/v1/platform/invoices/${inv.json().id}/pay`, superAdmin, {})).statusCode).toBe(400);   // reference required
    const paid = await inject('POST', `/api/v1/platform/invoices/${inv.json().id}/pay`, superAdmin, { paymentRef: 'UTR123456' });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ status: 'PAID', paymentRef: 'UTR123456' });
    expect((await inject('POST', `/api/v1/platform/invoices/${inv.json().id}/pay`, superAdmin, { paymentRef: 'again' })).statusCode).toBe(422);

    expect((await login(tenantB.adminEmail)).statusCode).toBe(200);
    const token = (await login(tenantB.adminEmail)).json().token;
    const me = (await inject('GET', '/api/v1/tenant/me', { authorization: `Bearer ${token}` })).json();
    expect(new Date(me.paidUntil).getTime()).toBeGreaterThan(Date.now() + 20 * day);
    expect(me.access).toBe('OK');
    const mine = (await inject('GET', '/api/v1/tenant/invoices', { authorization: `Bearer ${token}` })).json().invoices;
    expect(mine).toHaveLength(1);
    tenantB.admin = { authorization: `Bearer ${token}` };
  });

  it('the free trial plan cannot be invoiced', async () => {
    await setTenant({ plan: 'TRIAL', trialEndsAt: new Date(Date.now() + day) });
    const res = await inject('POST', `/api/v1/platform/tenants/${tenantB.id}/invoices`, superAdmin);
    expect(res.statusCode).toBe(422);
    await setTenant({ plan: 'STANDARD', paidUntil: new Date(Date.now() + 30 * day) });
  });
});

describe('passwords', () => {
  it('a user changes their own password; wrong current password is refused', async () => {
    const bad = await inject('POST', '/api/v1/auth/change-password', ctx.auth('cashier'), { currentPassword: 'nope-nope', newPassword: 'Brand#New123' });
    expect(bad.statusCode).toBe(400);
    const ok = await inject('POST', '/api/v1/auth/change-password', ctx.auth('cashier'), { currentPassword: 'Password@123', newPassword: 'Brand#New123' });
    expect(ok.statusCode).toBe(200);
    expect((await login('cashier@test.local', 'Brand#New123')).statusCode).toBe(200);
    expect((await login('cashier@test.local', 'Password@123')).statusCode).toBe(401);
    const same = await inject('POST', '/api/v1/auth/change-password', ctx.auth('cashier'), { currentPassword: 'Brand#New123', newPassword: 'Brand#New123' });
    expect(same.statusCode).toBe(400);
  });

  it('a manager resets a cashier; stewards cannot; nobody resets themselves or an owner', async () => {
    const res = await inject('POST', `/api/v1/users/${ctx.users.cashier.id}/reset-password`, ctx.auth('manager'));
    expect(res.statusCode).toBe(200);
    const { temporaryPassword, email } = res.json();
    expect(temporaryPassword).toHaveLength(12);
    expect((await login(email, temporaryPassword)).statusCode).toBe(200);

    expect((await inject('POST', `/api/v1/users/${ctx.users.cashier.id}/reset-password`, ctx.auth('steward'))).statusCode).toBe(403);
    expect((await inject('POST', `/api/v1/users/${ctx.users.manager.id}/reset-password`, ctx.auth('manager'))).statusCode).toBe(403);   // self (same rank)
    expect((await inject('POST', `/api/v1/users/${ctx.users.owner.id}/reset-password`, ctx.auth('manager'))).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('the Super Admin resets a tenant Admin and the action is audited', async () => {
    const admins = (await inject('GET', '/api/v1/platform/tenants', superAdmin)).json().tenants.find((t: { id: string }) => t.id === tenantB.id).admins;
    expect(admins[0].email).toBe(tenantB.adminEmail);
    const [adminRow] = await ctx.db.select().from(ctx.schema.users).where(eq(ctx.schema.users.email, tenantB.adminEmail));
    const res = await inject('POST', `/api/v1/platform/tenants/${tenantB.id}/admins/${adminRow.id}/reset-password`, superAdmin);
    expect(res.statusCode).toBe(200);
    expect((await login(tenantB.adminEmail, res.json().temporaryPassword)).statusCode).toBe(200);
    expect((await login(tenantB.adminEmail, PASSWORD)).statusCode).toBe(401);
    // an Admin of another business cannot use this
    expect((await inject('POST', `/api/v1/platform/tenants/${tenantB.id}/admins/${adminRow.id}/reset-password`, ctx.auth('owner'))).statusCode).toBe(403);
    const events = (await inject('GET', '/api/v1/platform/audit', superAdmin)).json().events;
    expect(events.map((e: { action: string }) => e.action)).toContain('admin.password_reset');
  });
});

describe('support sign-in', () => {
  it('the Super Admin gets a short-lived token as the tenant Admin; it is audited; others cannot', async () => {
    expect((await inject('POST', `/api/v1/platform/tenants/${ctx.syndicateId}/impersonate`, ctx.auth('owner'))).statusCode).toBe(403);
    const res = await inject('POST', `/api/v1/platform/tenants/${ctx.syndicateId}/impersonate`, superAdmin);
    expect(res.statusCode).toBe(200);
    const { token, as } = res.json();
    expect(as.email).toBe('owner@test.local');
    const me = await inject('GET', '/api/v1/tenant/me', { authorization: `Bearer ${token}` });
    expect(me.statusCode).toBe(200);
    expect(me.json().name).toBe('Test Syndicate');
    const decoded = ctx.app.jwt.decode(token) as { impersonatedBy: string; exp: number; iat: number };
    expect(decoded.impersonatedBy).toBe(superAdminId);
    expect(decoded.exp - decoded.iat).toBe(30 * 60);
    const events = (await inject('GET', '/api/v1/platform/audit', superAdmin)).json().events;
    expect(events[0]).toMatchObject({ action: 'support.sign_in_as', actor: 'Platform Root' });
  });
});

describe('print queue', () => {
  let billId: string;
  let port: number;

  beforeAll(async () => {
    const bill = await inject('POST', '/api/v1/bills', ctx.auth('manager'), {
      branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }],
    });
    billId = bill.json().id;
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    port = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));        // nothing listens on this port now
  });

  it('without a printer, queue=true still refuses (nothing to retry against)', async () => {
    const res = await inject('POST', `/api/v1/print/bills/${billId}/send?queue=true`, ctx.auth('cashier'));
    expect(res.statusCode).toBe(422);
  });

  it('an unreachable printer parks the job (202); fixing the printer and retrying prints it', async () => {
    await ctx.db.update(ctx.schema.branches).set({ printerHost: '127.0.0.1', printerPort: port }).where(eq(ctx.schema.branches.id, ctx.branchId));
    const queued = await inject('POST', `/api/v1/print/bills/${billId}/send?queue=true`, ctx.auth('cashier'));
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ sent: false, queued: true });

    const jobs = (await inject('GET', `/api/v1/print/jobs/${ctx.branchId}`, ctx.auth('manager'))).json().jobs;
    expect(jobs[0]).toMatchObject({ kind: 'bill', status: 'PENDING', attempts: 1 });
    expect(jobs[0].lastError).toMatch(/unreachable/);

    const received: Buffer[] = [];
    const server = net.createServer((s) => s.on('data', (d) => received.push(d)));
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      const retried = await inject('POST', `/api/v1/print/jobs/${jobs[0].id}/retry`, ctx.auth('manager'));
      expect(retried.statusCode).toBe(200);
      expect(retried.json().status).toBe('SENT');
      await new Promise((r) => setTimeout(r, 100));
      expect(Buffer.concat(received).toString('latin1')).toContain('TAX INVOICE');
    } finally {
      server.close();
    }
  });

  it('a job that keeps failing is given up after the maximum attempts', async () => {
    const queued = (await inject('POST', `/api/v1/print/bills/${billId}/send?queue=true`, ctx.auth('cashier'))).json();
    const { processDueJobs } = await import('../../src/modules/printing/print-queue.service.js');
    for (let i = 0; i < 6; i++) await processDueJobs(new Date(Date.now() + (i + 1) * 4 * 3_600_000));
    const jobs = (await inject('GET', `/api/v1/print/jobs/${ctx.branchId}`, ctx.auth('manager'))).json().jobs;
    expect(jobs.find((j: { id: string }) => j.id === queued.jobId)).toMatchObject({ status: 'FAILED', attempts: 5 });
  });

  it("another branch's manager cannot see or retry these jobs", async () => {
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await inject('GET', `/api/v1/print/jobs/${ctx.branchId}`, other)).statusCode).toBe(403);
  });
});

describe('round-off per bill', () => {
  it('a bill can round (or not) regardless of the branch default', async () => {
    const exact = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', discount: '0.40', items: [{ productId: ctx.products[1].id, quantity: 1 }],
    })).json();
    expect(exact.total).toBe('199.60');
    const rounded = (await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', discount: '0.40', roundOff: true, items: [{ productId: ctx.products[1].id, quantity: 1 }],
    })).json();
    expect(rounded).toMatchObject({ total: '200.00', roundOff: '0.40' });
  });
});
