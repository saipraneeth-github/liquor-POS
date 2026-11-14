import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
let superAdminId: string;
const stamp = Math.random().toString(36).slice(2, 8);

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });
const sa = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => inject(method, url, superAdmin, payload);

const newTenant = async (name: string) => {
  const email = `${name.toLowerCase()}.${stamp}@users.test`;
  const r = await sa('POST', '/platform/tenants', { name: `${name} ${stamp}`, plan: 'STANDARD', admin: { name: `${name} Admin`, email, password: 'Sup3rSecret!' } });
  expect(r.statusCode).toBe(201);
  return { id: r.json().tenant.id as string, email };
};
type U = { id: string; name: string; email: string; role: string; isActive: boolean; tenant: string | null; tenantId: string | null; lastLoginAt: string | null; isPlatformOwner: boolean };
const listUsers = async (qs = '') => (await sa('GET', `/platform/users${qs}`)).json() as { users: U[]; total: number };

beforeAll(async () => {
  ctx = await setupIntegration();
  const [root] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform Root', email: `root.${stamp}@users.local`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdminId = root.id;
  superAdmin = ctx.authFor({ sub: root.id, email: root.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('Super Admin: users across every business', () => {
  it('is for the Super Admin only', async () => {
    for (const path of ['/platform/users', '/platform/audit', '/platform/audit/actions']) {
      expect((await inject('GET', path, ctx.auth('owner'))).statusCode).toBe(403);
      expect((await inject('GET', path, ctx.auth('manager'))).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: 'GET', url: `/api/v1${path}` })).statusCode).toBe(401);
    }
  });

  it('lists everyone with their business, and filters by search, business, role and status', async () => {
    const a = await newTenant('Alpha');
    const b = await newTenant('Bravo');

    const all = await listUsers('?limit=200');
    expect(all.total).toBeGreaterThan(2);
    const alphaAdmin = all.users.find((u) => u.email === a.email)!;
    expect(alphaAdmin).toMatchObject({ role: 'owner', isActive: true, tenantId: a.id, isPlatformOwner: false });
    expect(alphaAdmin.tenant).toContain('Alpha');
    expect(all.users.find((u) => u.id === superAdminId)!.isPlatformOwner).toBe(true);

    expect((await listUsers(`?tenantId=${b.id}`)).users.map((u) => u.email)).toEqual([b.email]);
    expect((await listUsers(`?search=alpha.${stamp}`)).users.map((u) => u.email)).toEqual([a.email]);
    expect((await listUsers(`?search=${encodeURIComponent('Bravo Admin')}`)).users.map((u) => u.email)).toContain(b.email);
    expect((await listUsers('?role=manager&limit=200')).users.every((u) => u.role === 'manager')).toBe(true);
    expect((await listUsers('?status=inactive&limit=200')).users.every((u) => !u.isActive)).toBe(true);
    expect((await sa('GET', '/platform/users?role=wizard')).statusCode).toBe(400);
    expect((await sa('GET', '/platform/users?limit=9999')).statusCode).toBe(400);
  });

  it('records the last sign-in', async () => {
    const t = await newTenant('Charlie');
    expect((await listUsers(`?tenantId=${t.id}`)).users[0].lastLoginAt).toBeNull();
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: t.email, password: 'Sup3rSecret!' } });
    expect(login.statusCode).toBe(200);
    const after = (await listUsers(`?tenantId=${t.id}`)).users[0];
    expect(after.lastLoginAt).not.toBeNull();
    expect(Date.now() - new Date(after.lastLoginAt!).getTime()).toBeLessThan(60_000);
  });

  it('deactivates and reactivates an account: the very next request is refused, and it is audited with before and after', async () => {
    const t = await newTenant('Delta');
    const id = (await listUsers(`?tenantId=${t.id}`)).users[0].id;
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: t.email, password: 'Sup3rSecret!' } })).json().token as string;
    const authed = { authorization: `Bearer ${token}` };
    expect((await inject('GET', '/me', authed)).statusCode).toBe(200);

    const off = await sa('PATCH', `/platform/users/${id}`, { isActive: false });
    expect(off.statusCode).toBe(200);
    expect((await inject('GET', '/me', authed)).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: t.email, password: 'Sup3rSecret!' } })).statusCode).toBe(401);

    expect((await sa('PATCH', `/platform/users/${id}`, { isActive: true })).statusCode).toBe(200);
    expect((await inject('GET', '/me', authed)).statusCode).toBe(200);

    const trail = (await sa('GET', `/platform/audit?action=user.deactivate&tenantId=${t.id}`)).json();
    expect(trail.events).toHaveLength(1);
    expect(trail.events[0]).toMatchObject({ action: 'user.deactivate', actor: 'Platform Root', targetId: id });
    expect(trail.events[0].meta).toMatchObject({ before: { isActive: true }, after: { isActive: false } });
  });

  it('will not switch off yourself or another platform owner, and 404s for an unknown user', async () => {
    const self = await sa('PATCH', `/platform/users/${superAdminId}`, { isActive: false });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toMatch(/own account/i);
    const [other] = await ctx.db.insert(ctx.schema.users).values({
      name: 'Second Root', email: `root2.${stamp}@users.local`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner', branchId: null, syndicateId: null,
    }).returning();
    const r = await sa('PATCH', `/platform/users/${other.id}`, { isActive: false });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/platform owner/i);
    expect((await sa('PATCH', '/platform/users/00000000-0000-4000-8000-000000000000', { isActive: false })).statusCode).toBe(404);
    expect((await sa('PATCH', `/platform/users/${other.id}`, {})).statusCode).toBe(400);
  });

  it('resets a password to a temporary one that works, and never shows it again in the audit trail', async () => {
    const t = await newTenant('Echo');
    const id = (await listUsers(`?tenantId=${t.id}`)).users[0].id;
    const r = await sa('POST', `/platform/users/${id}/reset-password`);
    expect(r.statusCode).toBe(200);
    const temp = r.json().temporaryPassword as string;
    expect(temp.length).toBeGreaterThanOrEqual(8);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: t.email, password: 'Sup3rSecret!' } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: t.email, password: temp } })).statusCode).toBe(200);
    const trail = (await sa('GET', `/platform/audit?action=user.password_reset&tenantId=${t.id}`)).json();
    expect(trail.events).toHaveLength(1);
    expect(JSON.stringify(trail.events[0])).not.toContain(temp);
    expect((await sa('POST', `/platform/users/${superAdminId}/reset-password`)).statusCode).toBe(422);
  });
});

describe('Super Admin: audit log', () => {
  it('filters by actor, action, business and dates, pages through results, and lists the action names', async () => {
    const t = await newTenant('Foxtrot');
    const id = (await listUsers(`?tenantId=${t.id}`)).users[0].id;
    await sa('PATCH', `/platform/users/${id}`, { isActive: false });
    await sa('PATCH', `/platform/users/${id}`, { isActive: true });

    expect((await sa('PATCH', `/platform/tenants/${t.id}`, { plan: 'PRO' })).statusCode).toBe(200);
    const planChange = (await sa('GET', `/platform/audit?action=tenant.update&tenantId=${t.id}`)).json().events[0];
    expect(planChange.meta.before).toMatchObject({ plan: 'STANDARD' });
    expect(planChange.meta.after).toMatchObject({ plan: 'PRO' });

    const mine = (await sa('GET', `/platform/audit?tenantId=${t.id}&limit=200`)).json();
    expect(mine.total).toBeGreaterThanOrEqual(3);                                          // create + deactivate + activate
    expect(mine.events.every((e: { tenant: string | null }) => e.tenant?.includes('Foxtrot'))).toBe(true);

    const byActor = (await sa('GET', `/platform/audit?actor=${encodeURIComponent('platform root')}&tenantId=${t.id}`)).json();
    expect(byActor.total).toBe(mine.total);
    expect((await sa('GET', `/platform/audit?actor=nobody-by-this-name&tenantId=${t.id}`)).json().total).toBe(0);

    const byAction = (await sa('GET', `/platform/audit?action=user.&tenantId=${t.id}`)).json();
    expect(byAction.events.map((e: { action: string }) => e.action).sort()).toEqual(['user.activate', 'user.deactivate']);

    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    expect((await sa('GET', `/platform/audit?tenantId=${t.id}&from=${today}&to=${today}`)).json().total).toBe(mine.total);
    expect((await sa('GET', `/platform/audit?tenantId=${t.id}&to=2020-01-01`)).json().total).toBe(0);

    const page1 = (await sa('GET', `/platform/audit?tenantId=${t.id}&limit=2&offset=0`)).json();
    const page2 = (await sa('GET', `/platform/audit?tenantId=${t.id}&limit=2&offset=2`)).json();
    expect(page1.events).toHaveLength(2);
    expect(page1.events.map((e: { id: string }) => e.id)).not.toEqual(expect.arrayContaining(page2.events.map((e: { id: string }) => e.id)));
    expect(page1.total).toBe(mine.total);

    const actions = (await sa('GET', '/platform/audit/actions')).json().actions as string[];
    expect(actions).toEqual(expect.arrayContaining(['user.deactivate', 'user.activate']));
    expect(actions).toEqual([...actions].sort());

    expect((await sa('GET', '/platform/audit?from=yesterday')).statusCode).toBe(400);
    expect((await sa('GET', '/platform/audit?limit=100000')).statusCode).toBe(400);
  });
});
