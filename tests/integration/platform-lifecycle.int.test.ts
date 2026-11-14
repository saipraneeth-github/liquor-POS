import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
let superAdminId: string;
const stamp = Math.random().toString(36).slice(2, 7);
const DAY = 86_400_000;

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });
const sa = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => inject(method, url, superAdmin, payload);
const countOf = async (table: string, where = '') =>
  Number(((await ctx.db.execute(sql.raw(`select count(*)::int as n from ${table} ${where}`))) as unknown as { rows: { n: number }[] }).rows[0].n);

type T = { id: string; name: string; isActive: boolean; archivedAt: string | null; archiveReason: string | null; exportedAt: string | null };
const tenantRow = async (id: string) => ((await sa('GET', '/platform/tenants')).json().tenants as T[]).find((t) => t.id === id)!;
const audit = async (action: string, tenantId: string) => (await sa('GET', `/platform/audit?action=${action}&tenantId=${tenantId}&limit=200`)).json().events as Array<{ meta: Record<string, unknown>; actor: string | null }>;

/** Business activity under the seeded tenant: bills (one on credit), a credit customer, an expense, a bank account. */
async function addBusinessData() {
  const cashier = ctx.auth('cashier');
  const mgr = ctx.auth('manager');
  const cust = await inject('POST', `/customers/${ctx.branchId}`, mgr, { name: 'Credit Customer', phone: '9876543210', creditAllowed: true, creditLimit: '5000.00' });
  expect(cust.statusCode, cust.body).toBe(201);
  const bill = (extra: Record<string, unknown>) => inject('POST', '/bills', cashier, { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }], ...extra });
  const b1 = await bill({});
  expect(b1.statusCode, b1.body).toBe(201);
  const b2 = await bill({ paymentMode: 'CREDIT', customerId: cust.json().customer.id });
  expect(b2.statusCode, b2.body).toBe(201);
  const ex = await inject('POST', `/expenses/${ctx.branchId}`, mgr, { category: 'Rent', amount: '1200.00', paymentMode: 'CASH', expenseDate: new Date().toISOString().slice(0, 10) });
  expect(ex.statusCode, ex.body).toBe(201);
  const ba = await inject('POST', '/bank/accounts', mgr, { branchId: ctx.branchId, name: `Doomed acct ${stamp}` });
  expect(ba.statusCode, ba.body).toBe(201);
}

beforeAll(async () => {
  ctx = await setupIntegration();
  const [root] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Lifecycle Root', email: `root.${stamp}@life.local`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdminId = root.id;
  superAdmin = ctx.authFor({ sub: root.id, email: root.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('archive and restore', () => {
  it('is for the Super Admin only', async () => {
    const id = ctx.syndicateId;
    for (const [m, path] of [['POST', `/platform/tenants/${id}/archive`], ['POST', `/platform/tenants/${id}/restore`], ['GET', `/platform/tenants/${id}/export`], ['GET', `/platform/tenants/${id}/delete-preview`], ['POST', `/platform/tenants/${id}/delete`], ['POST', `/platform/invoices/${id}/void`]] as const) {
      expect((await inject(m, path, ctx.auth('owner'), {})).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: m, url: `/api/v1${path}` })).statusCode).toBe(401);
    }
    expect((await sa('POST', '/platform/tenants/00000000-0000-4000-8000-000000000000/archive', { reason: 'testing' })).statusCode).toBe(404);
  });

  it('archiving needs a reason, blocks everyone at once, and takes the business out of the figures', async () => {
    const created = await sa('POST', '/platform/tenants', { name: `Arch ${stamp}`, plan: 'STANDARD', admin: { name: 'A', email: `arch.${stamp}@life.test`, password: 'Sup3rSecret!' } });
    const id = created.json().tenant.id as string;
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `arch.${stamp}@life.test`, password: 'Sup3rSecret!' } })).json().token as string;
    const admin = { authorization: `Bearer ${token}` };
    expect((await inject('GET', '/me', admin)).statusCode).toBe(200);
    const before = (await sa('GET', '/platform/dashboard')).json();

    expect((await sa('POST', `/platform/tenants/${id}/archive`, {})).statusCode).toBe(400);
    expect((await sa('POST', `/platform/tenants/${id}/archive`, { reason: 'x' })).statusCode).toBe(400);
    const r = await sa('POST', `/platform/tenants/${id}/archive`, { reason: 'Stopped trading' });
    expect(r.statusCode).toBe(200);
    expect(new Date(r.json().deletableFrom).getTime() - new Date(r.json().archivedAt).getTime()).toBe(30 * DAY);

    expect(await tenantRow(id)).toMatchObject({ isActive: false, archiveReason: 'Stopped trading' });
    expect((await tenantRow(id)).archivedAt).not.toBeNull();
    expect((await inject('GET', '/me', admin)).statusCode).toBeGreaterThanOrEqual(401);                       // signed out on the next request
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `arch.${stamp}@life.test`, password: 'Sup3rSecret!' } })).statusCode).toBeGreaterThanOrEqual(401);
    expect((await sa('POST', `/platform/tenants/${id}/archive`, { reason: 'again' })).statusCode).toBe(409);

    const after = (await sa('GET', '/platform/dashboard')).json();
    expect(after.kpis.branches).toBe(before.kpis.branches);
    expect(after.plans.find((p: { plan: string }) => p.plan === 'STANDARD').count).toBe(before.plans.find((p: { plan: string }) => p.plan === 'STANDARD').count - 1);

    // an archived business cannot be switched back on by the plain suspend toggle, nor moved between plans
    const toggle = await sa('PATCH', `/platform/tenants/${id}`, { isActive: true });
    expect(toggle.statusCode).toBe(422);
    expect(toggle.json().error).toMatch(/restore/i);
    expect((await sa('POST', `/platform/tenants/${id}/plan`, { plan: 'PRO' })).statusCode).toBe(422);

    expect((await sa('POST', `/platform/tenants/${id}/restore`)).statusCode).toBe(200);
    expect(await tenantRow(id)).toMatchObject({ isActive: true, archivedAt: null, archiveReason: null });
    expect((await inject('GET', '/me', admin)).statusCode).toBe(200);
    expect((await sa('POST', `/platform/tenants/${id}/restore`)).statusCode).toBe(422);                     // not archived any more

    const log = (await audit('tenant.archive', id))[0];
    expect(log.meta).toMatchObject({ reason: 'Stopped trading', before: { isActive: true }, after: { isActive: false } });
    expect((await audit('tenant.restore', id))).toHaveLength(1);
  });
});

describe('permanent delete', () => {
  it('refuses until the business is archived for 30 days, has no unpaid invoice, and the exact name is typed', async () => {
    const id = ctx.syndicateId;
    const name = 'Test Syndicate';
    await addBusinessData();

    // not archived yet
    const early = await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: name, acknowledge: true });
    expect(early.statusCode).toBe(422);
    expect(early.json().error).toMatch(/archive the business first/i);

    // an unpaid invoice stands in the way (give it a paid plan so one can be raised)
    expect((await sa('PATCH', `/platform/tenants/${id}`, { plan: 'STANDARD' })).statusCode).toBe(200);
    const inv = await sa('POST', `/platform/tenants/${id}/invoices`);
    expect(inv.statusCode).toBe(201);

    expect((await sa('POST', `/platform/tenants/${id}/archive`, { reason: 'Closing down' })).statusCode).toBe(200);
    const tooSoon = await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: name, acknowledge: true });
    expect(tooSoon.statusCode).toBe(422);
    expect(tooSoon.json().error).toMatch(/too soon.*30 more days/i);

    // 31 days later …
    await ctx.db.update(ctx.schema.syndicates).set({ archivedAt: new Date(Date.now() - 31 * DAY) }).where(eq(ctx.schema.syndicates.id, id));
    const unpaid = await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: name, acknowledge: true });
    expect(unpaid.statusCode).toBe(422);
    expect(unpaid.json().error).toMatch(/unpaid invoices/i);
    expect((await sa('POST', `/platform/invoices/${inv.json().id}/void`)).statusCode).toBe(200);
    expect((await sa('POST', `/platform/invoices/${inv.json().id}/void`)).statusCode).toBe(422);               // already settled
    expect((await audit('invoice.void', id))).toHaveLength(1);

    // … the name must match exactly, and the warning must be acknowledged
    const wrong = await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: 'test syndicate', acknowledge: true });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error).toMatch(/does not match/i);
    expect((await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: name })).statusCode).toBe(400);
    expect((await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: name, acknowledge: false })).statusCode).toBe(400);
    expect(await countOf('syndicates', `where id = '${id}'`)).toBe(1);                                         // nothing was touched
  });

  it('shows what would go, exports it all without secrets, then deletes exactly that and nothing else', async () => {
    const id = ctx.syndicateId;
    const survivor = (await sa('POST', '/platform/tenants', { name: `Survivor ${stamp}`, plan: 'STANDARD', admin: { name: 'S', email: `survivor.${stamp}@life.test`, password: 'Sup3rSecret!' } })).json().tenant.id as string;

    const preview = (await sa('GET', `/platform/tenants/${id}/delete-preview`)).json();
    expect(preview).toMatchObject({ name: 'Test Syndicate', archived: true, eligible: true, daysLeft: 0 });
    expect(preview.unpaidInvoices.count).toBe(0);
    expect(preview.exportedAt).toBeNull();
    const rowsOf = (t: string) => preview.tables.find((x: { table: string }) => x.table === t)?.rows ?? 0;
    expect(rowsOf('bills')).toBe(2);
    expect(rowsOf('bill_items')).toBe(2);
    expect(rowsOf('customers')).toBe(1);
    expect(rowsOf('expenses')).toBe(1);
    expect(rowsOf('users')).toBeGreaterThanOrEqual(5);
    expect(rowsOf('branches')).toBe(1);
    expect(preview.tables.map((x: { table: string }) => x.table)).not.toContain('audit_log');                  // the audit trail is not part of what goes
    expect(preview.tables.map((x: { table: string }) => x.table)).not.toContain('categories');                 // shared catalogue data is not either

    const exp = (await sa('GET', `/platform/tenants/${id}/export`)).json();
    expect(exp.business).toBe('Test Syndicate');
    expect(exp.tables.bills).toHaveLength(2);
    expect(exp.tables.customers[0]).toMatchObject({ name: 'Credit Customer' });
    expect(exp.tables.journal_vouchers.length).toBeGreaterThan(0);
    expect(JSON.stringify(exp)).not.toMatch(/password_hash|passwordHash|\$2[aby]\$/);                         // no password hashes anywhere
    expect(exp.rowCount).toBe(preview.totalRows);
    expect((await tenantRow(id)).exportedAt).not.toBeNull();

    const auditBefore = await countOf('audit_log');
    const otherStock = await countOf('stock', `where branch_id = '${ctx.otherBranchId}'`);
    const productsBefore = await countOf('products');
    const categoriesBefore = await countOf('categories');
    const usersBefore = await countOf('users');

    const del = await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: '  Test Syndicate ', acknowledge: true });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: true, name: 'Test Syndicate' });
    expect(del.json().rows).toBe(preview.totalRows);

    // everything the business owned is gone …
    expect(await countOf('syndicates', `where id = '${id}'`)).toBe(0);
    expect(await countOf('branches', `where id = '${ctx.branchId}'`)).toBe(0);
    // (this business was the only one with activity in this database, so these tables must now be empty)
    for (const t of ['bills', 'bill_items', 'customers', 'credit_transactions', 'expenses', 'journal_vouchers', 'journal_lines', 'bank_accounts', 'subscription_invoices']) {
      expect(await countOf(t), t).toBe(0);
    }
    expect(await countOf('stock', `where branch_id = '${ctx.branchId}'`)).toBe(0);
    expect(await countOf('users', `where syndicate_id = '${id}' or branch_id = '${ctx.branchId}'`)).toBe(0);

    // … and nothing else: the other business, the unaffiliated branch, the shared catalogue
    expect((await tenantRow(survivor)).isActive).toBe(true);
    expect(await countOf('users', `where syndicate_id = '${survivor}'`)).toBe(1);
    expect(await countOf('branches', `where id = '${ctx.otherBranchId}'`)).toBe(1);
    expect(await countOf('stock', `where branch_id = '${ctx.otherBranchId}'`)).toBe(otherStock);
    expect(await countOf('products')).toBe(productsBefore);
    expect(await countOf('categories')).toBe(categoriesBefore);
    expect(await countOf('users')).toBe(usersBefore - preview.tables.find((x: { table: string }) => x.table === 'users').rows);

    // the audit trail survives, now with one more entry, and no longer points at deleted people
    expect(await countOf('audit_log')).toBe(auditBefore + 1);
    expect(await countOf('audit_log', `where actor_id not in (select id from users)`)).toBe(0);
    const last = (await sa('GET', `/platform/audit?action=tenant.delete&limit=5`)).json().events[0];
    expect(last).toMatchObject({ action: 'tenant.delete', actor: 'Lifecycle Root' });
    expect(last.meta).toMatchObject({ name: 'Test Syndicate', exportedBeforeDelete: true, archiveReason: 'Closing down' });
    expect(last.meta.tables.bills).toBe(2);

    // a second attempt finds nothing
    expect((await sa('POST', `/platform/tenants/${id}/delete`, { confirmName: 'Test Syndicate', acknowledge: true })).statusCode).toBe(404);
    expect(superAdminId).toBeTruthy();
  });
});
