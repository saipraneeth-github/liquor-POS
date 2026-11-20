/**
 * A password change or reset ends every session signed in before it; the person who changed it keeps working
 * with the fresh token handed back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

/** A token for the seeded user that was issued `ageSec` seconds ago (a stolen / older session). */
function tokenFrom(role: 'cashier' | 'steward', ageSec: number) {
  const u = ctx.users[role];
  const iat = Math.floor(Date.now() / 1000) - ageSec;
  return { authorization: `Bearer ${ctx.app.jwt.sign({ sub: u.id, email: u.email, role, branchId: ctx.branchId, syndicateId: null, iat })}` };
}
const me = (headers: { authorization: string }) => ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers });

describe('own password change', () => {
  it('ends other sessions, keeps this one through the returned token', async () => {
    const stolen = tokenFrom('cashier', 30);
    const current = tokenFrom('cashier', 0);
    expect((await me(stolen)).statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: current,
      payload: { currentPassword: 'Password@123', newPassword: 'Changed#12345' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { token } = res.json();
    expect(typeof token).toBe('string');

    expect((await me(stolen)).statusCode).toBe(401);                                  // the older session is over
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(200);    // the fresh token works
  });
});

describe('password reset by a manager', () => {
  it('ends the reset person\'s existing sessions', async () => {
    const before = tokenFrom('steward', 30);
    expect((await me(before)).statusCode).toBe(200);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/v1/users/${ctx.users.steward.id}/reset-password`, headers: ctx.auth('manager'),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await me(before)).statusCode).toBe(401);
  });
});
