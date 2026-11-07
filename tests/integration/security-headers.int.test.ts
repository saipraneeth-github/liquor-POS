import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('security headers', () => {
  it('sends a CSP on API responses', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not break plain-HTTP LAN deployments (no https upgrade, no COOP)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    // upgrade-insecure-requests turns http://192.168.x.x asset URLs into https:// and the app renders blank
    expect(String(res.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
  });

  it('keeps the SPA shell free of inline scripts (CSP script-src has no unsafe-inline)', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });

  it('no longer serves the old single-file page: /preview is not special, and nothing is exempt from the CSP', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/preview', headers: { accept: 'text/html' } });
    expect(res.body).not.toContain('sidebarBackdrop');   // markup that only the old page had
    if (res.statusCode === 200) expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
  });
});
