import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { resetLoginThrottle } from '../../src/modules/auth/auth.service.js';

let ctx: IntegrationContext;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });
beforeEach(() => resetLoginThrottle());

const login = (email: string, password: string, ip = '10.0.0.1') =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, remoteAddress: ip });

describe('what the sign-in screen is told', () => {
  it('a wrong password says how many tries are left, counting down to the lockout', async () => {
    const first = await login('cashier@test.local', 'wrong-password', '10.9.9.1');
    expect(first.statusCode).toBe(401);
    expect(first.json()).toMatchObject({ error: 'Invalid email or password', attemptsLeft: 9 });
    const second = await login('cashier@test.local', 'wrong-password', '10.9.9.1');
    expect(second.json().attemptsLeft).toBe(8);
    for (let i = 0; i < 7; i++) await login('cashier@test.local', 'wrong-password', '10.9.9.1');
    expect((await login('cashier@test.local', 'wrong-password', '10.9.9.1')).json().attemptsLeft).toBe(0);
  });

  it('an unknown e-mail counts down the same way, so it does not reveal which e-mails exist', async () => {
    const res = await login('nobody@test.local', 'whatever', '10.9.9.2');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Invalid email or password', attemptsLeft: 9 });
  });

  it('a lockout carries a countdown (body and Retry-After header)', async () => {
    for (let i = 0; i < 10; i++) await login('cashier@test.local', 'wrong-password', '10.9.9.3');
    const res = await login('cashier@test.local', 'Password@123', '10.9.9.3');
    expect(res.statusCode).toBe(429);
    const secs = res.json().retryAfterSeconds as number;
    expect(secs).toBeGreaterThan(14 * 60);
    expect(secs).toBeLessThanOrEqual(15 * 60);
    expect(Number(res.headers['retry-after'])).toBe(secs);
  });

  it('a health check is available under the API prefix', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('per-account login throttle', () => {
  it('locks an account after repeated failures, even with the right password', async () => {
    for (let i = 0; i < 10; i++) expect((await login('cashier@test.local', 'wrong-password')).statusCode).toBe(401);
    expect((await login('cashier@test.local', 'Password@123')).statusCode).toBe(429);
  });

  it('an attacker cannot lock the real user out: the lockout is per client IP', async () => {
    for (let i = 0; i < 10; i++) await login('cashier@test.local', 'wrong-password', '203.0.113.9');   // attacker
    expect((await login('cashier@test.local', 'Password@123', '203.0.113.9')).statusCode).toBe(429);    // attacker is locked
    expect((await login('cashier@test.local', 'Password@123', '198.51.100.7')).statusCode).toBe(200);   // real user, other IP
  });

  it('a distributed attack on one account still hits the per-account ceiling', async () => {
    for (let i = 0; i < 100; i++) await login('manager@test.local', 'wrong-password', `192.0.2.${(i % 250) + 1}`);
    const res = await login('manager@test.local', 'Password@123', '198.51.100.99');   // a fresh IP, correct password
    expect(res.statusCode).toBe(429);
  });

  it('does not lock other accounts', async () => {
    for (let i = 0; i < 10; i++) await login('cashier@test.local', 'wrong-password');
    expect((await login('manager@test.local', 'Password@123')).statusCode).toBe(200);
  });

  it('a successful login clears the failure count', async () => {
    for (let i = 0; i < 9; i++) await login('cashier@test.local', 'wrong-password');
    expect((await login('cashier@test.local', 'Password@123')).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login('cashier@test.local', 'wrong-password')).statusCode).toBe(401);
  });

  it('accepts a short legacy password at login (strength is enforced only when set)', async () => {
    expect((await login('cashier@test.local', 'x')).statusCode).toBe(401);   // wrong, but not a 400 validation error
  });

  it('rejects an oversized password with 400', async () => {
    expect((await login('cashier@test.local', 'a'.repeat(101))).statusCode).toBe(400);
  });
});
