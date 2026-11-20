/**
 * Forced password change after an administrator reset; account-wide sign-in lock that does not shut out a known device;
 * ending a support sign-in without the browser keeping the Super Admin token.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { resetLoginThrottle } from '../../src/modules/auth/auth.service.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

const login = (email: string, password: string, ip = '127.0.0.1') =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, remoteAddress: ip });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('forced password change after a reset', () => {
  it('the person can only see themselves and change the password until they do', async () => {
    const reset = await ctx.app.inject({ method: 'POST', url: `/api/v1/users/${ctx.users.cashier.id}/reset-password`, headers: ctx.auth('manager') });
    expect(reset.statusCode, reset.body).toBe(200);
    const temp = reset.json().temporaryPassword as string;

    const signIn = await login(ctx.users.cashier.email, temp);
    expect(signIn.statusCode, signIn.body).toBe(200);
    const token = signIn.json().token as string;

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);

    const blocked = await ctx.app.inject({ method: 'GET', url: `/api/v1/products?branchId=${ctx.branchId}`, headers: bearer(token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('PASSWORD_CHANGE_REQUIRED');

    const change = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: bearer(token),
      payload: { currentPassword: temp, newPassword: 'MyOwn#Pass12345' },
    });
    expect(change.statusCode, change.body).toBe(200);
    const fresh = change.json().token as string;

    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(fresh) })).json().mustChangePassword).toBe(false);
    const open = await ctx.app.inject({ method: 'GET', url: `/api/v1/products?branchId=${ctx.branchId}`, headers: bearer(fresh) });
    expect(open.statusCode, open.body).toBe(200);
  });
});

describe('a support sign-in is not asked to choose the person\'s new password', () => {
  it('the person is forced to, the Super Admin acting as them is not', async () => {
    await ctx.db.update(ctx.schema.users).set({ mustChangePassword: true }).where(eq(ctx.schema.users.id, ctx.users.owner.id));
    const own = ctx.auth('owner');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/branches', headers: own })).statusCode).toBe(403);   // the person: blocked until they choose

    const claims = ctx.app.jwt.decode<Record<string, unknown>>(own.authorization.replace('Bearer ', ''))!;
    const { iat: _i, exp: _e, ...rest } = claims;
    const support = bearer(ctx.app.jwt.sign({ ...rest, impersonatedBy: ctx.users.owner.id }));
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/branches', headers: support })).statusCode).toBe(200);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: support });
    expect(me.json().mustChangePassword).toBe(false);
    // and the person's own /me still says they must
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: own })).json().mustChangePassword).toBe(true);
    await ctx.db.update(ctx.schema.users).set({ mustChangePassword: false }).where(eq(ctx.schema.users.id, ctx.users.owner.id));
  });
});

describe('account-wide sign-in lock', () => {
  const email = () => ctx.users.manager.email;
  const fillAccountCounter = async () => {
    await resetLoginThrottle();
    await ctx.db.insert(ctx.schema.loginThrottle).values({ key: `acct:${email().toLowerCase()}`, count: 100 });
  };

  it('blocks a new address once 100 failures were spread over many addresses', async () => {
    await fillAccountCounter();
    const res = await login(email(), 'Password@123', '10.9.9.9');
    expect(res.statusCode).toBe(429);
  });

  it('does not shut out a device the real user signed in from in the last 30 days', async () => {
    await fillAccountCounter();
    await ctx.db.insert(ctx.schema.loginThrottle).values({ key: `known:${email().toLowerCase()}|10.9.9.8`, count: 1 });
    const res = await login(email(), 'Password@123', '10.9.9.8');
    expect(res.statusCode, res.body).toBe(200);
  });

  it('forgets a device not seen for more than 30 days', async () => {
    await fillAccountCounter();
    await ctx.db.insert(ctx.schema.loginThrottle).values({ key: `known:${email().toLowerCase()}|10.9.9.7`, count: 1, firstAt: new Date(Date.now() - 31 * 86_400_000) });
    expect((await login(email(), 'Password@123', '10.9.9.7')).statusCode).toBe(429);
  });

  it('a successful sign-in remembers the device', async () => {
    await resetLoginThrottle();
    expect((await login(email(), 'Password@123', '10.9.9.6')).statusCode).toBe(200);
    const rows = await ctx.db.select().from(ctx.schema.loginThrottle).where(eq(ctx.schema.loginThrottle.key, `known:${email().toLowerCase()}|10.9.9.6`));
    expect(rows).toHaveLength(1);
  });

  it('a wrong password from a known device still counts against that device', async () => {
    await resetLoginThrottle();
    await login(email(), 'Password@123', '10.9.9.5');
    const bad = await login(email(), 'wrong-password', '10.9.9.5');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().attemptsLeft).toBe(9);
  });
});
