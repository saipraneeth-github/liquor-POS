import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
let superAdminId: string;
const stamp = Math.random().toString(36).slice(2, 7);
let seq = 0;

const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });
const sa = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => inject(method, url, superAdmin, payload);

type Role = { id: string; key: string; name: string; level: string; permissions: string[]; pages: string[] | null; isSystem: boolean; isActive: boolean; userCount: number; summary: { granted: number; total: number } | null };
const roleList = async () => (await sa('GET', '/platform/roles')).json() as { roles: Role[]; catalog: { groups: { id: string; permissions: { key: string }[] }[]; pages: { key: string }[]; levels: string[] }; assignable: { id: string; name: string }[] };
const newRole = async (over: Record<string, unknown> = {}) => {
  const r = await sa('POST', '/platform/roles', { name: `Role ${stamp} ${++seq}`, level: 'cashier', permissions: [], pages: null, ...over });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Role;
};
const assign = (userId: string, roleId: string) => sa('PUT', `/platform/users/${userId}/role`, { roleId });
const me = async (user: 'cashier' | 'manager') => (await inject('GET', '/me', ctx.auth(user))).json();
const audit = async (action: string) => (await sa('GET', `/platform/audit?action=${action}&limit=50`)).json().events as Array<{ meta: Record<string, unknown>; targetId: string }>;

/** A fresh cashier-level person, so one test's role never leaks into another's. */
async function newCashier() {
  const n = ++seq;
  const email = `cashier.${stamp}.${n}@roles.test`;
  const [u] = await ctx.db.insert(ctx.schema.users).values({ name: `Cashier ${n}`, email, passwordHash: await bcrypt.hash('Password@123', 4), role: 'cashier', branchId: ctx.branchId }).returning();
  return { id: u.id, auth: ctx.authFor({ sub: u.id, email, role: 'cashier', branchId: ctx.branchId }) };
}
const sellBill = (auth: Record<string, string>, extra: Record<string, unknown> = {}) =>
  inject('POST', '/bills', auth, { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }], ...extra });

beforeAll(async () => {
  ctx = await setupIntegration();
  const [root] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Roles Root', email: `root.${stamp}@roles.local`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdminId = root.id;
  superAdmin = ctx.authFor({ sub: root.id, email: root.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('the role list', () => {
  it('is for the Super Admin only', async () => {
    for (const [m, path] of [['GET', '/platform/roles'], ['POST', '/platform/roles'], ['PATCH', `/platform/roles/${ctx.branchId}`], ['POST', `/platform/roles/${ctx.branchId}/retire`], ['PUT', `/platform/users/${ctx.users.cashier.id}/role`]] as const) {
      expect((await inject(m, path, ctx.auth('owner'), {})).statusCode).toBe(403);
      expect((await inject(m, path, ctx.auth('manager'), {})).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: m, url: `/api/v1${path}` })).statusCode).toBe(401);
    }
  });

  it('starts with the five built-in roles, in rank order, with how many people hold each, and the editor\'s catalogue', async () => {
    const { roles, catalog, assignable } = await roleList();
    expect(roles.filter((r) => r.isSystem).map((r) => r.key)).toEqual(['owner', 'office_admin', 'manager', 'cashier', 'steward']);
    expect(roles.find((r) => r.key === 'manager')!.userCount).toBeGreaterThanOrEqual(1);          // the seeded manager (and the other branch's)
    expect(roles.find((r) => r.key === 'cashier')!.userCount).toBeGreaterThanOrEqual(1);
    expect(roles.find((r) => r.key === 'cashier')!.summary).toBeNull();                              // built-in: nothing explicit to summarise
    expect(catalog.levels).toEqual(['steward', 'cashier', 'manager']);
    expect(catalog.groups.flatMap((g) => g.permissions.map((p) => p.key))).toContain('bills.void');
    expect(catalog.pages.map((p) => p.key)).toContain('pos');
    expect(assignable.map((r) => r.name)).toEqual(expect.arrayContaining(['Manager', 'Cashier', 'Steward']));
    expect(assignable.map((r) => r.name)).not.toContain('Owner / Admin');                           // never offered
  });
});

describe('creating and editing roles', () => {
  it('validates the form, and refuses duplicate names (including built-in ones)', async () => {
    const bad = async (over: Record<string, unknown>) => sa('POST', '/platform/roles', { name: 'Valid name', level: 'cashier', permissions: [], pages: null, ...over });
    expect((await bad({ name: 'ab' })).statusCode).toBe(400);
    expect((await bad({ name: 'x'.repeat(41) })).statusCode).toBe(400);
    expect((await bad({ level: 'owner' })).statusCode).toBe(400);                                    // custom roles stop at manager
    expect((await bad({ level: 'office_admin' })).statusCode).toBe(400);
    expect((await bad({ permissions: ['teleport'] })).statusCode).toBe(422);
    expect((await bad({ permissions: ['invoices.approve'] })).statusCode).toBe(422);                 // approving needs seeing costs
    expect((await bad({ pages: ['platform'] })).statusCode).toBe(422);
    expect((await bad({ name: 'Manager' })).statusCode).toBe(409);
    expect((await bad({ name: 'OFFICE ADMIN' })).statusCode).toBe(409);

    const a = await newRole({ name: `Counter Lead ${stamp}`, permissions: ['stock.move', 'bills.void', 'bills.void'] });
    expect(a.key).toBe(`counter_lead_${stamp}`);
    expect(a.permissions).toEqual(['stock.move', 'bills.void']);                                      // de-duplicated, in the catalogue's order
    expect((await bad({ name: `counter lead ${stamp}` })).statusCode).toBe(409);
    expect((await audit('role.create')).some((e) => e.targetId === a.id)).toBe(true);
    const row = (await roleList()).roles.find((r) => r.id === a.id)!;
    expect(row).toMatchObject({ isSystem: false, isActive: true, userCount: 0, summary: { granted: 2 } });
  });

  it('built-in roles cannot be edited or retired', async () => {
    const manager = (await roleList()).roles.find((r) => r.key === 'manager')!;
    const r = await sa('PATCH', `/platform/roles/${manager.id}`, { permissions: [] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/built-in/i);
    expect((await sa('POST', `/platform/roles/${manager.id}/retire`)).statusCode).toBe(422);
    expect((await sa('PATCH', '/platform/roles/00000000-0000-4000-8000-000000000000', { name: 'Whatever' })).statusCode).toBe(404);
  });

  it('edits are audited with before and after, validated, and a rename cannot collide', async () => {
    const a = await newRole({ permissions: ['bills.void'] });
    const b = await newRole();
    const r = await sa('PATCH', `/platform/roles/${a.id}`, { permissions: ['bills.void', 'discount.unlimited'], pages: ['pos', 'bills'], description: 'Leads the counter' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ permissions: ['bills.void', 'discount.unlimited'], pages: ['pos', 'bills'], description: 'Leads the counter' });
    const log = (await audit('role.update')).find((e) => e.targetId === a.id)!;
    expect((log.meta.before as { permissions: string[] }).permissions).toEqual(['bills.void']);
    expect((log.meta.after as { permissions: string[] }).permissions).toContain('discount.unlimited');
    expect((await sa('PATCH', `/platform/roles/${a.id}`, { permissions: ['invoices.approve'] })).statusCode).toBe(422);
    expect((await sa('PATCH', `/platform/roles/${a.id}`, { name: b.name })).statusCode).toBe(409);
    expect((await sa('PATCH', `/platform/roles/${a.id}`, { level: 'owner' })).statusCode).toBe(400);
    expect((await sa('PATCH', `/platform/roles/${a.id}`, {})).statusCode).toBe(400);
    // an update that does not mention the description leaves it alone; a blank one clears it
    expect((await sa('PATCH', `/platform/roles/${a.id}`, { name: `${a.name} v2` })).json().description).toBe('Leads the counter');
    expect((await sa('PATCH', `/platform/roles/${a.id}`, { description: '  ' })).json().description).toBeNull();
  });
});

describe('a role changes what a person may do', () => {
  it('a cashier-level role with "void bills" lets a cashier void; a plain cashier cannot; the change applies at once', async () => {
    const role = await newRole({ name: `Counter Lead ${stamp} v`, level: 'cashier', permissions: ['bills.void'] });
    const lead = await newCashier();
    const plain = await newCashier();

    const bill = (await sellBill(lead.auth)).json() as { id: string };
    const voidBill = (who: Record<string, string>, id: string) => inject('POST', `/bills/${id}/void`, who, { voidReason: 'Wrong item rung' });
    expect((await voidBill(lead.auth, bill.id)).statusCode).toBe(403);                              // not yet: still a plain cashier
    const done = await assign(lead.id, role.id);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ role: 'cashier', roleName: role.name });

    const bill2 = (await sellBill(plain.auth)).json() as { id: string };
    expect((await voidBill(plain.auth, bill2.id)).statusCode).toBe(403);                            // the plain cashier still cannot
    const denied = await voidBill(plain.auth, bill2.id);
    expect(denied.json()).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'bills.void' });
    expect((await voidBill(lead.auth, bill2.id)).statusCode).toBe(200);                             // the role holder can, on a bill of the branch

    // take the permission away from the role: the very next request is refused
    const bill3 = (await sellBill(lead.auth)).json() as { id: string };
    expect((await sa('PATCH', `/platform/roles/${role.id}`, { permissions: [] })).statusCode).toBe(200);
    expect((await voidBill(lead.auth, bill3.id)).statusCode).toBe(403);
  });

  it('/me carries the role name and effective permissions; the discount cap follows the role', async () => {
    const role = await newRole({ level: 'cashier', permissions: ['discount.unlimited'] });
    const c = await newCashier();
    const before = (await inject('GET', '/me', c.auth)).json();
    expect(before).toMatchObject({ role: 'cashier', roleName: null, discountCapPct: 5 });
    expect(before.permissions['discount.unlimited']).toBe(false);

    const tenPercent = await sellBill(c.auth, { discount: '100.00' });                              // ₹100 off ₹1000
    expect(tenPercent.statusCode).not.toBe(201);
    expect((await assign(c.id, role.id)).statusCode).toBe(200);
    const after = (await inject('GET', '/me', c.auth)).json();
    expect(after).toMatchObject({ role: 'cashier', roleName: role.name, discountCapPct: null });
    expect(after.permissions['discount.unlimited']).toBe(true);
    expect((await sellBill(c.auth, { discount: '100.00' })).statusCode).toBe(201);
  });

  it('a manager-level custom role is not a full manager: without "see cost prices" it sees no costs and no supplier invoices', async () => {
    const role = await newRole({ name: `Shop Lead ${stamp}`, level: 'manager', permissions: ['bills.void'] });
    const n = ++seq;
    const [u] = await ctx.db.insert(ctx.schema.users).values({ name: `Lead ${n}`, email: `lead.${stamp}.${n}@roles.test`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'manager', branchId: ctx.branchId }).returning();
    const lead = ctx.authFor({ sub: u.id, email: u.email, role: 'manager', branchId: ctx.branchId });
    expect(((await inject('GET', '/products', lead)).json() as Array<Record<string, unknown>>)[0].costPrice).toBeDefined();   // a built-in manager sees cost
    expect((await inject('GET', `/invoices/${ctx.branchId}`, lead)).statusCode).toBe(200);

    expect((await assign(u.id, role.id)).statusCode).toBe(200);
    expect(((await inject('GET', '/products', lead)).json() as Array<Record<string, unknown>>)[0].costPrice).toBeUndefined();
    const inv = await inject('GET', `/invoices/${ctx.branchId}`, lead);
    expect(inv.statusCode).toBe(403);
    expect(inv.json()).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'cost.view' });
    expect((await inject('GET', '/me', lead)).json().permissions['bills.void']).toBe(true);

    // back to the built-in manager: everything returns
    const managerRole = (await roleList()).roles.find((r) => r.key === 'manager')!;
    expect((await assign(u.id, managerRole.id)).statusCode).toBe(200);
    expect((await inject('GET', `/invoices/${ctx.branchId}`, lead)).statusCode).toBe(200);
    expect((await inject('GET', '/me', lead)).json()).toMatchObject({ role: 'manager', roleName: null });
  });

  it('changing a role\'s level moves its people with it', async () => {
    const role = await newRole({ level: 'cashier' });
    const c = await newCashier();
    await assign(c.id, role.id);
    expect((await sa('PATCH', `/platform/roles/${role.id}`, { level: 'steward' })).statusCode).toBe(200);
    const [row] = await ctx.db.select().from(ctx.schema.users).where(eq(ctx.schema.users.id, c.id));
    expect(row.role).toBe('steward');
    expect((await sa('GET', '/platform/roles')).json().roles.find((r: Role) => r.id === role.id).userCount).toBe(1);
  });

  it('a role\'s pages become the menu of people who have none of their own', async () => {
    const role = await newRole({ pages: ['pos', 'bills'] });
    const c = await newCashier();
    await assign(c.id, role.id);
    const pages = (await inject('GET', '/me', c.auth)).json().pages as { routePath: string; canAccess: boolean }[];
    expect(pages.find((p) => p.routePath === 'pos')!.canAccess).toBe(true);
    expect(pages.find((p) => p.routePath === 'bank')!.canAccess).toBe(false);
    // a person's own menu wins
    await ctx.db.insert(ctx.schema.userPagePermissions).values({ userId: c.id, routePath: 'bank', canAccess: true });
    const own = (await inject('GET', '/me', c.auth)).json().pages as { routePath: string }[];
    expect(own).toEqual([{ routePath: 'bank', canAccess: true }]);
  });

  it('a manager managing a person on a role sees the role\'s defaults, and cannot grant what their own role lacks', async () => {
    const role = await newRole({ level: 'cashier', permissions: ['bills.void'] });
    const c = await newCashier();
    await assign(c.id, role.id);
    const view = (await inject('GET', `/users/${c.id}/permissions`, ctx.auth('manager'))).json();
    const perm = (k: string) => view.permissions.find((p: { key: string }) => p.key === k);
    expect(perm('bills.void')).toMatchObject({ roleDefault: true, effective: true, override: null });
    expect(perm('cost.view')).toMatchObject({ roleDefault: false, effective: false });

    // an exception on top of the role: switch "void bills" off for this one person
    const off = await inject('PUT', `/users/${c.id}/permissions`, ctx.auth('manager'), { overrides: { 'bills.void': false }, saleTypeIds: [] });
    expect(off.statusCode, off.body).toBe(200);
    const after = (await inject('GET', `/users/${c.id}/permissions`, ctx.auth('manager'))).json();
    expect(after.permissions.find((p: { key: string }) => p.key === 'bills.void')).toMatchObject({ roleDefault: true, override: false, effective: false });
    const bill = (await sellBill(c.auth)).json() as { id: string };
    expect((await inject('POST', `/bills/${bill.id}/void`, c.auth, { voidReason: 'Test' })).statusCode).toBe(403);

    // a limited manager cannot hand out cost access they do not hold
    const limited = await newRole({ level: 'manager', permissions: ['bills.void'] });
    const [mgr] = await ctx.db.insert(ctx.schema.users).values({ name: 'Limited', email: `limited.${stamp}.${++seq}@roles.test`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'manager', branchId: ctx.branchId }).returning();
    await assign(mgr.id, limited.id);
    const limitedAuth = ctx.authFor({ sub: mgr.id, email: mgr.email, role: 'manager', branchId: ctx.branchId });
    const grant = await inject('PUT', `/users/${c.id}/permissions`, limitedAuth, { overrides: { 'cost.view': true }, saleTypeIds: [] });
    expect(grant.statusCode).toBe(403);
    expect(grant.json().error).toMatch(/cannot grant a permission you do not have/i);
  });
});

describe('putting people on roles', () => {
  it('lists the role by name in the Super Admin\'s Users, and audits the change with before and after', async () => {
    const role = await newRole({ name: `Named Role ${stamp}` });
    const c = await newCashier();
    await assign(c.id, role.id);
    const users = (await sa('GET', `/platform/users?search=${encodeURIComponent(`cashier.${stamp}`)}&limit=100`)).json().users as Array<{ id: string; role: string; roleName: string | null }>;
    expect(users.find((u) => u.id === c.id)).toMatchObject({ role: 'cashier', roleName: role.name });
    const log = (await audit('user.role_changed')).find((e) => e.targetId === c.id)!;
    expect(log.meta).toMatchObject({ before: { role: 'cashier', roleName: 'cashier' }, after: { role: 'cashier', roleName: role.name } });
  });

  it('refuses a retired role, yourself, owners, office admins and nonsense; people on a retired role keep it', async () => {
    const role = await newRole({ level: 'cashier', permissions: ['bills.void'] });
    const holder = await newCashier();
    const other = await newCashier();
    expect((await assign(holder.id, role.id)).statusCode).toBe(200);
    expect((await assign(holder.id, role.id)).statusCode).toBe(409);                                // already there

    expect((await sa('POST', `/platform/roles/${role.id}/retire`)).statusCode).toBe(200);
    expect((await sa('POST', `/platform/roles/${role.id}/retire`)).statusCode).toBe(200);           // idempotent
    expect((await assign(other.id, role.id)).statusCode).toBe(422);                                 // not for anyone new
    expect((await roleList()).assignable.map((r) => r.id)).not.toContain(role.id);
    expect((await inject('GET', '/me', holder.auth)).json().permissions['bills.void']).toBe(true);  // but the holder keeps it
    expect((await sa('POST', `/platform/roles/${role.id}/reactivate`)).statusCode).toBe(200);
    expect((await assign(other.id, role.id)).statusCode).toBe(200);

    const { roles } = await roleList();
    const managerRole = roles.find((r) => r.key === 'manager')!;
    const ownerRole = roles.find((r) => r.key === 'owner')!;
    expect((await assign(superAdminId, managerRole.id)).statusCode).toBe(422);                      // your own role
    expect((await assign(ctx.users.owner.id, managerRole.id)).statusCode).toBe(422);               // an owner
    expect((await assign(ctx.users.office_admin.id, managerRole.id)).statusCode).toBe(422);        // an office admin
    expect((await assign(holder.id, ownerRole.id)).statusCode).toBe(422);                           // never owner level
    expect((await assign('00000000-0000-4000-8000-000000000000', role.id)).statusCode).toBe(404);
    expect((await assign(holder.id, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await sa('PUT', `/platform/users/${holder.id}/role`, { roleId: 'nope' })).statusCode).toBe(400);
  });
});
