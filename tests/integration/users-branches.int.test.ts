/**
 * users & branches modules. These plugins may not be wired into buildApp() yet, so they are
 * mounted on a local Fastify instance that shares the integration database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext, type Role } from './helpers.js';
import { userRoutes } from '../../src/modules/users/user.routes.js';
import { branchRoutes } from '../../src/modules/branches/branch.routes.js';

let ctx: IntegrationContext;
let app: FastifyInstance;
let platformId: string;

type Payload = { sub: string; email: string; role: Role; branchId: string | null; syndicateId: string | null };
const tokenFor = (p: Payload) => ({ authorization: `Bearer ${app.jwt.sign(p)}` });
const as = (role: Role) => tokenFor({
  sub: ctx.users[role].id, email: ctx.users[role].email, role,
  branchId: role === 'owner' ? null : ctx.branchId,
  syndicateId: role === 'owner' ? ctx.syndicateId : null,
});
const platform = () => tokenFor({ sub: platformId, email: 'platform@test.local', role: 'owner', branchId: null, syndicateId: null });

beforeAll(async () => {
  ctx = await setupIntegration();
  app = Fastify();
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  app.register(userRoutes, { prefix: '/api/v1' });
  app.register(branchRoutes, { prefix: '/api/v1' });
  await app.ready();

  const [p] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform', email: 'platform@test.local', passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner',
  }).returning();
  platformId = p.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.app.close();
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, headers?: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as any });

// ─── /me ──────────────────────────────────────────────────────────────────────

describe('GET /me', () => {
  it('returns the profile without passwordHash; 401 without token', async () => {
    const res = await req('GET', '/me', as('steward'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'steward@test.local', role: 'steward', branchId: ctx.branchId });
    expect(res.json().branch.code).toBe('MAIN');
    expect(res.json()).not.toHaveProperty('passwordHash');
    expect((await req('GET', '/me')).statusCode).toBe(401);
  });
});

// ─── USERS ────────────────────────────────────────────────────────────────────

describe('users', () => {
  let newCashierId: string;

  it('manager creates a cashier in own branch (email lowercased, bcrypt hash)', async () => {
    const res = await req('POST', '/users', as('manager'), {
      name: 'New Cashier', email: 'New.Cashier@Test.Local', password: 'Secret@123', role: 'cashier',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'new.cashier@test.local', branchId: ctx.branchId, role: 'cashier' });
    expect(res.json()).not.toHaveProperty('passwordHash');
    newCashierId = res.json().id;
    const [row] = await ctx.db.select().from(ctx.schema.users).where(eq(ctx.schema.users.id, newCashierId));
    expect(await bcrypt.compare('Secret@123', row.passwordHash)).toBe(true);
  });

  it('rejects duplicates (409), short passwords (400), elevated roles (403) and foreign branches (403)', async () => {
    expect((await req('POST', '/users', as('manager'), { name: 'Dup', email: 'NEW.cashier@test.local', password: 'Secret@123', role: 'cashier' })).statusCode).toBe(409);
    expect((await req('POST', '/users', as('manager'), { name: 'Short', email: 's@test.local', password: 'short', role: 'cashier' })).statusCode).toBe(400);
    expect((await req('POST', '/users', as('manager'), { name: 'Boss', email: 'boss@test.local', password: 'Secret@123', role: 'manager' })).statusCode).toBe(403);
    expect((await req('POST', '/users', as('manager'), { name: 'Away', email: 'away@test.local', password: 'Secret@123', role: 'cashier', branchId: ctx.otherBranchId })).statusCode).toBe(403);
    expect((await req('POST', '/users', as('cashier'), { name: 'X', email: 'x@test.local', password: 'Secret@123', role: 'steward' })).statusCode).toBe(403);
  });

  it('syndicate owner creates managers only in syndicate branches', async () => {
    expect((await req('POST', '/users', as('owner'), { name: 'M2', email: 'm2@test.local', password: 'Secret@123', role: 'manager', branchId: ctx.branchId })).statusCode).toBe(201);
    expect((await req('POST', '/users', as('owner'), { name: 'M3', email: 'm3@test.local', password: 'Secret@123', role: 'manager', branchId: ctx.otherBranchId })).statusCode).toBe(403);
    const owner = await req('POST', '/users', as('owner'), { name: 'Co-owner', email: 'co@test.local', password: 'Secret@123', role: 'owner' });
    expect(owner.statusCode).toBe(201);
    expect(owner.json()).toMatchObject({ syndicateId: ctx.syndicateId, branchId: null });
  });

  it('GET /users is scoped (manager: own branch; syndicate owner: syndicate; platform: all)', async () => {
    const mgr = (await req('GET', '/users', as('manager'))).json();
    expect(mgr.every((u: any) => u.branchId === ctx.branchId)).toBe(true);
    expect(mgr.some((u: any) => u.id === ctx.otherBranchManager.id)).toBe(false);
    expect(mgr[0]).not.toHaveProperty('passwordHash');

    const own = (await req('GET', '/users', as('owner'))).json();
    expect(own.some((u: any) => u.id === ctx.otherBranchManager.id)).toBe(false);
    expect(own.some((u: any) => u.email === 'co@test.local')).toBe(true);

    const all = (await req('GET', '/users', platform())).json();
    expect(all.some((u: any) => u.id === ctx.otherBranchManager.id)).toBe(true);

    expect((await req('GET', `/users?branchId=${ctx.otherBranchId}`, as('manager'))).statusCode).toBe(403);
    expect((await req('GET', '/users', as('cashier'))).statusCode).toBe(403);
  });

  it('PATCH enforces rank: manager can deactivate a cashier but not elevate, nor touch others', async () => {
    const off = await req('PATCH', `/users/${newCashierId}`, as('manager'), { isActive: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().isActive).toBe(false);
    expect((await req('PATCH', `/users/${newCashierId}`, as('manager'), { role: 'manager' })).statusCode).toBe(403);
    expect((await req('PATCH', `/users/${ctx.otherBranchManager.id}`, as('manager'), { isActive: false })).statusCode).toBe(404);
    expect((await req('PATCH', `/users/${ctx.users.owner.id}`, as('manager'), { name: 'x' })).statusCode).toBe(404);
    expect((await req('PATCH', `/users/${ctx.users.manager.id}`, as('manager'), { isActive: false })).statusCode).toBe(403);
    const rename = await req('PATCH', `/users/${ctx.users.manager.id}`, as('manager'), { name: 'Renamed Manager' });
    expect(rename.statusCode).toBe(200);
    expect((await req('PATCH', `/users/${newCashierId}`, as('manager'), {})).statusCode).toBe(400);
  });

  it('page matrix: GET/PUT by manager, validated keys, replaces entries', async () => {
    const url = `/users/${ctx.users.cashier.id}/pages`;
    const put = await req('PUT', url, as('manager'), { pages: [{ routePath: 'pos', canAccess: true }, { routePath: 'reports', canAccess: false }] });
    expect(put.statusCode).toBe(200);
    expect(put.json().pages).toEqual([{ routePath: 'pos', canAccess: true }, { routePath: 'reports', canAccess: false }]);

    const replaced = await req('PUT', url, as('manager'), { pages: [{ routePath: 'bills', canAccess: true }] });
    expect(replaced.json().pages).toEqual([{ routePath: 'bills', canAccess: true }]);
    expect((await req('GET', url, as('manager'))).json().pages).toHaveLength(1);

    expect((await req('PUT', url, as('manager'), { pages: [{ routePath: 'hacker-page', canAccess: true }] })).statusCode).toBe(400);
    expect((await req('PUT', `/users/${ctx.users.manager.id}/pages`, as('manager'), { pages: [] })).statusCode).toBe(403);
    expect((await req('GET', `/users/${ctx.otherBranchManager.id}/pages`, as('manager'))).statusCode).toBe(404);
  });
});

// ─── BRANCHES ─────────────────────────────────────────────────────────────────

describe('branches', () => {
  it('GET /branches returns accessible branches only', async () => {
    const synd = (await req('GET', '/branches', as('owner'))).json();
    expect(synd.map((b: any) => b.id)).toEqual([ctx.branchId]);
    const cashier = (await req('GET', '/branches', as('cashier'))).json();
    expect(cashier.map((b: any) => b.id)).toEqual([ctx.branchId]);
    const all = (await req('GET', '/branches', platform())).json();
    expect(all.map((b: any) => b.id)).toEqual(expect.arrayContaining([ctx.branchId, ctx.otherBranchId]));
  });

  it('syndicate owner creates branches inside its own syndicate; duplicate code → 409; manager → 403', async () => {
    const res = await req('POST', '/branches', as('owner'), { name: 'Second Shop', code: 'sec2', parentBranchId: ctx.branchId });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ code: 'SEC2', syndicateId: ctx.syndicateId, parentBranchId: ctx.branchId });

    expect((await req('POST', '/branches', as('owner'), { name: 'Dup', code: 'SEC2' })).statusCode).toBe(409);
    expect((await req('POST', '/branches', as('manager'), { name: 'Nope', code: 'NOPE' })).statusCode).toBe(403);
    expect((await req('POST', '/branches', as('owner'), { name: 'Bad', code: 'x' })).statusCode).toBe(400);
    expect((await req('POST', '/branches', as('owner'), { name: 'Steal', code: 'STL', parentBranchId: ctx.otherBranchId })).statusCode).toBe(422);

    const after = (await req('GET', '/branches', as('owner'))).json();
    expect(after).toHaveLength(2);
  });

  it('PATCH /branches/:id only within scope', async () => {
    const ok = await req('PATCH', `/branches/${ctx.branchId}`, as('owner'), { address: 'MG Road' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().address).toBe('MG Road');
    expect((await req('PATCH', `/branches/${ctx.otherBranchId}`, as('owner'), { name: 'Mine now' })).statusCode).toBe(404);
    expect((await req('PATCH', `/branches/${ctx.branchId}`, as('owner'), { parentBranchId: ctx.branchId })).statusCode).toBe(422);
    expect((await req('PATCH', `/branches/${ctx.otherBranchId}`, platform(), { name: 'Other Renamed' })).statusCode).toBe(200);
  });
});
