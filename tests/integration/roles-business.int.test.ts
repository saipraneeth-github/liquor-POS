import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
const stamp = Math.random().toString(36).slice(2, 7);
let seq = 0;

const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });

/** A custom role, as the Super Admin would have made it (inserted directly: the Super Admin side is tested elsewhere). */
async function newRole(level: 'steward' | 'cashier' | 'manager', permissions: string[], over: Record<string, unknown> = {}) {
  const name = `Biz Role ${stamp} ${++seq}`;
  const [r] = await ctx.db.insert(ctx.schema.roles).values({ key: `biz_${stamp}_${seq}`, name, nameKey: name.toLowerCase(), level, permissions, ...over } as never).returning();
  return r;
}
async function newUser(role: 'cashier' | 'manager' | 'steward', roleId: string | null = null) {
  const n = ++seq;
  const email = `u.${stamp}.${n}@biz.test`;
  const [u] = await ctx.db.insert(ctx.schema.users).values({ name: `User ${n}`, email, passwordHash: await bcrypt.hash('Password@123', 4), role, roleId, branchId: ctx.branchId }).returning();
  return { id: u.id, auth: ctx.authFor({ sub: u.id, email, role, branchId: ctx.branchId }) };
}
const roleOf = async (id: string) => (await ctx.db.select().from(ctx.schema.users).where(eq(ctx.schema.users.id, id)))[0];
const assignable = async (auth: Record<string, string>) => ((await inject('GET', '/roles', auth)).json().roles as { id: string; name: string; level: string; isSystem: boolean }[]);
const systemRoleId = async (key: string) => (await ctx.db.select().from(ctx.schema.roles).where(eq(ctx.schema.roles.key, key)))[0].id;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('a business gives its staff the roles the Super Admin made', () => {
  it('lists only the roles the person may give: below their own level, and permissions they hold themselves', async () => {
    const counter = await newRole('cashier', ['bills.void']);
    const costly = await newRole('cashier', ['cost.view']);
    const tooHigh = await newRole('manager', ['bills.void']);
    const retired = await newRole('cashier', [], { isActive: false });

    const forManager = await assignable(ctx.auth('manager'));
    const ids = forManager.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([counter.id, costly.id]));                       // a built-in manager holds every permission
    expect(ids).not.toContain(tooHigh.id);                                                       // a manager cannot give the manager level
    expect(ids).not.toContain(retired.id);
    expect(forManager.filter((r) => r.isSystem).map((r) => r.name).sort()).toEqual(['Cashier', 'Steward']);

    // a limited manager (their own role grants only "void bills") cannot give a role that includes cost access
    const limitedRole = await newRole('manager', ['bills.void']);
    const limited = await newUser('manager', limitedRole.id);
    const forLimited = (await assignable(limited.auth)).map((r) => r.id);
    expect(forLimited).toContain(counter.id);
    expect(forLimited).not.toContain(costly.id);

    // the business Admin may also give the manager level; cashiers have no staff to manage
    expect((await assignable(ctx.auth('owner'))).map((r) => r.id)).toContain(tooHigh.id);
    expect((await inject('GET', '/roles', ctx.auth('cashier'))).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/roles' })).statusCode).toBe(401);
  });

  it('a manager puts a cashier on a role, and it takes effect and is audited; the rules hold', async () => {
    const role = await newRole('cashier', ['bills.void'], { pages: ['pos', 'bills'] });
    const cashier = await newUser('cashier');
    const put = (target: string, roleId: string, auth = ctx.auth('manager')) => inject('PUT', `/users/${target}/role`, auth, { roleId });

    const done = await put(cashier.id, role.id);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ role: 'cashier', roleId: role.id, roleName: role.name });
    const me = (await inject('GET', '/me', cashier.auth)).json();
    expect(me).toMatchObject({ role: 'cashier', roleName: role.name });
    expect(me.permissions['bills.void']).toBe(true);
    expect(((await inject('GET', `/users?branchId=${ctx.branchId}`, ctx.auth('manager'))).json() as { id: string; roleId: string | null }[]).find((u) => u.id === cashier.id)!.roleId).toBe(role.id);

    expect((await put(cashier.id, role.id)).statusCode).toBe(409);                                // already has it
    const back = await put(cashier.id, await systemRoleId('cashier'));                           // back to the built-in role
    expect(back.statusCode).toBe(200);
    expect((await roleOf(cashier.id)).roleId).toBeNull();

    // who may be changed, and to what
    expect((await put(ctx.users.manager.id, role.id)).statusCode).toBe(403);                      // a manager cannot change a peer…
    expect((await put(cashier.id, role.id, cashier.auth)).statusCode).toBe(403);                  // …a cashier cannot manage anyone…
    expect((await put(ctx.users.owner.id, role.id)).statusCode).toBe(404);                        // …and the business Admin is not even visible to them
    expect((await put(ctx.users.office_admin.id, role.id)).statusCode).toBe(403);
    const higher = await newRole('manager', []);
    expect((await put(cashier.id, higher.id)).statusCode).toBe(403);                              // a manager cannot give the manager level
    expect((await put(cashier.id, await systemRoleId('owner'))).statusCode).toBe(403);
    const retired = await newRole('cashier', [], { isActive: false });
    expect((await put(cashier.id, retired.id)).statusCode).toBe(422);
    expect((await put(cashier.id, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await put('00000000-0000-4000-8000-000000000000', role.id)).statusCode).toBe(404);
    expect((await inject('PUT', `/users/${cashier.id}/role`, ctx.auth('manager'), { roleId: 'nope' })).statusCode).toBe(400);

    // another business's branch is out of reach
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await put(cashier.id, role.id, other)).statusCode).toBe(404);

    const trail = (await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'user.role_changed'))).filter((e) => e.targetId === cashier.id);
    expect(trail.length).toBeGreaterThanOrEqual(2);
    expect(trail[0].actorId).toBe(ctx.users.manager.id);
    expect(trail[0].meta).toMatchObject({ before: { roleName: 'cashier' }, after: { roleName: role.name } });
  });

  it('a person can be created on a role; the level must match and the creator must be allowed to give it', async () => {
    const role = await newRole('cashier', ['bills.void']);
    const make = (extra: Record<string, unknown>, auth = ctx.auth('manager')) =>
      inject('POST', '/users', auth, { name: 'New Hire', email: `hire.${stamp}.${++seq}@biz.test`, password: 'Password@123', role: 'cashier', branchId: ctx.branchId, ...extra });
    const ok = await make({ roleId: role.id });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ role: 'cashier', roleId: role.id });

    expect((await make({ role: 'steward', roleId: role.id })).statusCode).toBe(422);              // level mismatch
    const costly = await newRole('cashier', ['cost.view']);
    const limited = await newUser('manager', (await newRole('manager', ['bills.void'])).id);
    expect((await make({ roleId: costly.id }, limited.auth)).statusCode).toBe(403);               // cannot give what they do not hold
    expect((await make({ roleId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    const plain = await make({});
    expect(plain.statusCode).toBe(201);
    expect(plain.json().roleId).toBeNull();                                                       // without a role: the built-in one
  });

  it('choosing a built-in role through the old edit path leaves the custom role', async () => {
    const role = await newRole('cashier', ['bills.void']);
    const u = await newUser('cashier', role.id);
    const r = await inject('PATCH', `/users/${u.id}`, ctx.auth('manager'), { role: 'steward' });
    expect(r.statusCode).toBe(200);
    const row = await roleOf(u.id);
    expect(row).toMatchObject({ role: 'steward', roleId: null });
    const same = await inject('PATCH', `/users/${(await newUser('cashier', role.id)).id}`, ctx.auth('manager'), { name: 'Renamed' });
    expect(same.statusCode).toBe(200);                                                            // renaming alone keeps the role
    expect(same.json().roleId).toBe(role.id);
  });
});

describe('new permissions: accounting, bank, day closing', () => {
  const b = () => ctx.branchId;

  it('built-in roles behave exactly as before: managers in, cashiers and stewards out', async () => {
    for (const url of [`/accounting/trial-balance/${b()}`, `/accounting/ledgers/${b()}`, `/expenses/${b()}`, `/bank/accounts?branchId=${b()}`, `/closing?branchId=${b()}`]) {
      expect((await inject('GET', url, ctx.auth('manager'))).statusCode, url).toBe(200);
      for (const who of ['cashier', 'steward'] as const) {
        const r = await inject('GET', url, ctx.auth(who));
        expect(r.statusCode, `${who} ${url}`).toBe(403);
      }
    }
    // the same for the owner and the office admin: never restricted
    expect((await inject('GET', `/accounting/trial-balance/${b()}`, ctx.auth('office_admin'))).statusCode).toBe(200);
  });

  it('a cashier-level role can be given just the one area', async () => {
    const viewer = await newUser('cashier', (await newRole('cashier', ['accounting.view'])).id);
    expect((await inject('GET', `/accounting/trial-balance/${b()}`, viewer.auth)).statusCode).toBe(200);
    expect((await inject('GET', `/expenses/${b()}`, viewer.auth)).statusCode).toBe(200);
    const post = await inject('POST', `/expenses/${b()}`, viewer.auth, { category: 'Rent', amount: '100.00', paymentMode: 'CASH', expenseDate: '2026-11-01' });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'accounting.post' });
    expect((await inject('GET', `/bank/accounts?branchId=${b()}`, viewer.auth)).statusCode).toBe(403);   // only the one area

    const poster = await newUser('cashier', (await newRole('cashier', ['accounting.view', 'accounting.post'])).id);
    const ok = await inject('POST', `/expenses/${b()}`, poster.auth, { category: 'Rent', amount: '100.00', paymentMode: 'CASH', expenseDate: new Date().toISOString().slice(0, 10) });
    expect(ok.statusCode, ok.body).toBe(201);

    const banker = await newUser('cashier', (await newRole('cashier', ['bank.reconcile'])).id);
    expect((await inject('GET', `/bank/accounts?branchId=${b()}`, banker.auth)).statusCode).toBe(200);
    expect((await inject('GET', `/accounting/trial-balance/${b()}`, banker.auth)).statusCode).toBe(403);

    const closer = await newUser('cashier', (await newRole('cashier', ['day.close'])).id);
    expect((await inject('GET', `/closing?branchId=${b()}`, closer.auth)).statusCode).toBe(200);
    expect((await inject('GET', `/bank/accounts?branchId=${b()}`, closer.auth)).statusCode).toBe(403);
  });

  it('one manager can have a single area switched off for them, and a manager role can leave areas out', async () => {
    const m = await newUser('manager');
    expect((await inject('GET', `/bank/accounts?branchId=${b()}`, m.auth)).statusCode).toBe(200);
    const off = await inject('PUT', `/users/${m.id}/permissions`, ctx.auth('owner'), { overrides: { 'bank.reconcile': false }, saleTypeIds: [] });
    expect(off.statusCode, off.body).toBe(200);
    expect((await inject('GET', `/bank/accounts?branchId=${b()}`, m.auth)).statusCode).toBe(403);
    expect((await inject('GET', `/accounting/trial-balance/${b()}`, m.auth)).statusCode).toBe(200);

    const shopLead = await newUser('manager', (await newRole('manager', ['bills.void'])).id);
    expect((await inject('GET', `/accounting/trial-balance/${b()}`, shopLead.auth)).statusCode).toBe(403);
    expect((await inject('GET', `/closing?branchId=${b()}`, shopLead.auth)).statusCode).toBe(403);
    expect((await inject('GET', '/me', shopLead.auth)).json().permissions).toMatchObject({ 'accounting.view': false, 'bank.reconcile': false, 'day.close': false, 'bills.void': true });
  });

  it('posting entries without seeing the books is refused as a personal exception too', async () => {
    const c = await newUser('cashier');
    const r = await inject('PUT', `/users/${c.id}/permissions`, ctx.auth('owner'), { overrides: { 'accounting.post': true }, saleTypeIds: [] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/See accounting and reports/);
  });
});
