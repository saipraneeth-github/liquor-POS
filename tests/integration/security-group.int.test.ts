/**
 * Medium security findings: support sign-in limits and attribution, printer host policy, production config refusals,
 * quality-module references across businesses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

/** The syndicate owner's token, marked as a Super Admin support sign-in. */
function supportToken() {
  const own = ctx.app.jwt.decode<Record<string, unknown>>(ctx.auth('owner').authorization.replace('Bearer ', ''))!;
  const { iat: _i, exp: _e, ...claims } = own;
  return { authorization: `Bearer ${ctx.app.jwt.sign({ ...claims, impersonatedBy: ctx.users.owner.id })}` };
}

describe('support sign-in', () => {
  it('can read and do normal work, but not change passwords or users', async () => {
    const h = supportToken();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: h })).statusCode).toBe(200);
    const pw = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: h, payload: { currentPassword: 'Password@123', newPassword: 'Another#12345' } });
    expect(pw.statusCode).toBe(403);
    const reset = await ctx.app.inject({ method: 'POST', url: `/api/v1/users/${ctx.users.manager.id}/reset-password`, headers: h });
    expect(reset.statusCode).toBe(403);
    const create = await ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: h, payload: { name: 'X', email: 'x@x.com', password: 'Password@123', role: 'cashier', branchId: ctx.branchId } });
    expect(create.statusCode).toBe(403);
  });

  it('actions it does take are audited with who is really behind them', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/inventory/stock/${ctx.branchId}/clear`, headers: supportToken() });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'inventory.clear'));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.at(-1)!.meta)).toContain('impersonatedBy');
  });
});

describe('printer host', () => {
  it('refuses the cloud metadata address and accepts a LAN address', async () => {
    const bad = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/branches/${ctx.branchId}`, headers: ctx.auth('owner'), payload: { printerHost: '169.254.169.254', printerPort: 9100 } });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/branches/${ctx.branchId}`, headers: ctx.auth('owner'), payload: { printerHost: '192.168.1.50', printerPort: 9100 } });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('production configuration', () => {
  async function bootWith(env: Record<string, string>) {
    const saved = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'production', CORS_ORIGIN: 'https://app.example.com', ALLOW_MOCK_PAYMENTS: '1', ...env });
    try {
      const { buildApp } = await import('../../src/app.js');
      const app = buildApp();
      await app.close();
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }
  it('refuses the .env.example JWT placeholder', async () => {
    expect(await bootWith({ JWT_SECRET: 'change_me_to_a_long_random_secret_at_least_32_chars' })).toMatch(/placeholder/);
  });
  it('refuses TRUST_PROXY=true', async () => {
    expect(await bootWith({ JWT_SECRET: 'x'.repeat(48), TRUST_PROXY: 'true' })).toMatch(/TRUST_PROXY/);
  });
  it('accepts a hop count', async () => {
    const msg = await bootWith({ JWT_SECRET: 'x'.repeat(48), TRUST_PROXY: '1' });
    expect(msg ?? '').not.toMatch(/TRUST_PROXY|placeholder/);
  });
});

describe('quality module references', () => {
  it('an owner or parent from another business is refused', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/quality/modules', headers: ctx.auth('manager'), payload: { key: 'sec.a', name: 'Sec A' } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const foreign = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/quality/modules/${id}`, headers: ctx.auth('manager'), payload: { ownerId: ctx.otherBranchManager.id } });
    expect(foreign.statusCode).toBe(422);
    const self = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/quality/modules/${id}`, headers: ctx.auth('manager'), payload: { parentId: id } });
    expect(self.statusCode).toBe(422);
    const own = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/quality/modules/${id}`, headers: ctx.auth('manager'), payload: { ownerId: ctx.users.cashier.id } });
    expect(own.statusCode, own.body).toBe(200);
  });
});
