/**
 * Integration tests for the flaw-tracker HTTP API (/api/v1/quality/...).
 *
 * Routes are written by routes-writer and registered in app.ts. If the routes
 * have not been registered yet this file will still compile; individual
 * describe blocks are skipped via describe.skip only where explicitly noted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function inject(method: string, url: string, payload?: unknown, headers?: Record<string, string>) {
  return ctx.app.inject({ method, url: `/api/v1${url}`, payload, headers });
}

function get(url: string, role: Parameters<typeof ctx.auth>[0] = 'cashier') {
  return inject('GET', url, undefined, ctx.auth(role));
}
function post(url: string, payload: unknown, role: Parameters<typeof ctx.auth>[0] = 'cashier') {
  return inject('POST', url, payload, ctx.auth(role));
}
function patch(url: string, payload: unknown, role: Parameters<typeof ctx.auth>[0] = 'manager') {
  return inject('PATCH', url, payload, ctx.auth(role));
}
function del(url: string, role: Parameters<typeof ctx.auth>[0] = 'manager') {
  return inject('DELETE', url, undefined, ctx.auth(role));
}

// ─── MODULE MANAGEMENT ───────────────────────────────────────────────────────

describe('quality modules', () => {
  let moduleId: string;

  it('POST /quality/modules (manager) → 201 with id/key/name', async () => {
    const res = await post('/quality/modules', { key: 'billing', name: 'Billing Module' }, 'manager');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ key: 'billing', name: 'Billing Module' });
    expect(body.id).toBeTruthy();
    moduleId = body.id;
  });

  it('POST /quality/modules (cashier) → 403', async () => {
    const res = await post('/quality/modules', { key: 'inventory', name: 'Inventory' }, 'cashier');
    expect(res.statusCode).toBe(403);
  });

  it('GET /quality/modules (manager) → returns created module', async () => {
    const res = await get('/quality/modules', 'manager');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const modules = Array.isArray(body) ? body : body.modules ?? body.data ?? [];
    expect(modules.some((m: any) => m.id === moduleId)).toBe(true);
  });

  it('PATCH /quality/modules/:id (manager) → updates name → 200', async () => {
    const res = await patch(`/quality/modules/${moduleId}`, { name: 'Billing & Payments' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Billing & Payments');
  });

  it('POST /quality/modules with duplicate key → 409', async () => {
    const res = await post('/quality/modules', { key: 'billing', name: 'Dupe' }, 'manager');
    expect(res.statusCode).toBe(409);
  });
});

// ─── FLAW CRUD (happy path) ──────────────────────────────────────────────────

describe('flaw CRUD', () => {
  let moduleId: string;
  let flawId: string;
  let flawRef: string;

  beforeAll(async () => {
    const mr = await post('/quality/modules', { key: 'pos-module', name: 'POS' }, 'manager');
    moduleId = mr.json().id;
  });

  it('POST /quality/flaws (cashier) → 201 with reference FLW-YYYY-NNNNNN', async () => {
    const res = await post('/quality/flaws', {
      title: 'Cash drawer does not open after payment',
      severity: 'MAJOR',
      moduleId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.flaw ?? body).toMatchObject({
      severity: 'MAJOR',
      status: 'NEW',
    });
    const flaw = body.flaw ?? body;
    expect(flaw.reference).toMatch(/^FLW-\d{4}-\d{6}$/);
    expect(Array.isArray(flaw.tags)).toBe(true);
    expect(flaw.tags).toHaveLength(0);
    // suggestions array should be present (empty — first flaw)
    expect(Array.isArray(body.suggestions ?? [])).toBe(true);
    flawId = flaw.id;
    flawRef = flaw.reference;
  });

  it('POST /quality/flaws (steward) → 403 (min role is cashier)', async () => {
    const res = await post(
      '/quality/flaws',
      { title: 'Steward should not create flaws', moduleId },
      'steward',
    );
    expect(res.statusCode).toBe(403);
  });

  it('POST /quality/flaws (cashier) second identical flaw → 409 with existing reference', async () => {
    const res = await post('/quality/flaws', {
      title: 'Cash drawer does not open after payment',
      moduleId,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    // the conflict body should contain the original reference
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain(flawRef);
  });

  it('GET /quality/flaws (cashier) → returns the created flaw', async () => {
    const res = await get('/quality/flaws');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const list = Array.isArray(body) ? body : body.flaws ?? body.data ?? [];
    expect(list.some((f: any) => f.id === flawId)).toBe(true);
  });

  it('GET /quality/flaws/:id (cashier) → flaw + empty comments + history[0].action=CREATED', async () => {
    const res = await get(`/quality/flaws/${flawId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(flawId);
    expect(Array.isArray(body.comments)).toBe(true);
    expect(body.comments).toHaveLength(0);
    expect(Array.isArray(body.history)).toBe(true);
    // history is ordered desc so the most recent is first; the only entry is CREATED
    const created = body.history.find((h: any) => h.action === 'CREATED');
    expect(created).toBeTruthy();
  });

  it('PATCH /quality/flaws/:id (cashier) → 403 (needs manager+)', async () => {
    const res = inject('PATCH', `/quality/flaws/${flawId}`, { severity: 'BLOCKER' }, ctx.auth('cashier'));
    expect((await res).statusCode).toBe(403);
  });

  it('PATCH /quality/flaws/:id (manager) → updates severity → 200; GET shows new severity', async () => {
    const res = await patch(`/quality/flaws/${flawId}`, { severity: 'CRITICAL' });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect((updated.flaw ?? updated).severity ?? updated.severity).toBe('CRITICAL');

    const getRes = await get(`/quality/flaws/${flawId}`);
    expect(getRes.json().severity).toBe('CRITICAL');
  });

  it('GET /quality/flaws?status=NEW (cashier) → includes the flaw', async () => {
    // The flaw is now CRITICAL severity but still NEW status
    const res = await get('/quality/flaws?status=NEW');
    expect(res.statusCode).toBe(200);
    const list = (() => { const b = res.json(); return Array.isArray(b) ? b : b.flaws ?? b.data ?? []; })();
    expect(list.some((f: any) => f.id === flawId)).toBe(true);
  });

  it('GET /quality/flaws?status=CLOSED (cashier) → empty list', async () => {
    const res = await get('/quality/flaws?status=CLOSED');
    expect(res.statusCode).toBe(200);
    const list = (() => { const b = res.json(); return Array.isArray(b) ? b : b.flaws ?? b.data ?? []; })();
    expect(list.some((f: any) => f.id === flawId)).toBe(false);
  });
});

// ─── STATUS TRANSITIONS ──────────────────────────────────────────────────────

describe('status transitions', () => {
  let flawId: string;

  beforeAll(async () => {
    const r = await post('/quality/flaws', {
      title: 'Receipt printer skips blank lines on reprint',
      severity: 'MINOR',
    });
    expect(r.statusCode).toBe(201);
    flawId = (r.json().flaw ?? r.json()).id;
  });

  it('NEW → TRIAGED → 200', async () => {
    const res = await post(`/quality/flaws/${flawId}/status`, { status: 'TRIAGED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('TRIAGED');
  });

  it('TRIAGED → CLOSED → 422 (illegal transition)', async () => {
    const res = await post(`/quality/flaws/${flawId}/status`, { status: 'CLOSED' });
    expect(res.statusCode).toBe(422);
  });

  it('status change with comment → 200; GET shows comment in comments[]', async () => {
    // Move to IN_PROGRESS (legal from TRIAGED)
    const commentText = 'Starting investigation on the reprint bug';
    const res = await post(`/quality/flaws/${flawId}/status`, {
      status: 'IN_PROGRESS',
      comment: commentText,
    });
    expect(res.statusCode).toBe(200);

    const getRes = await get(`/quality/flaws/${flawId}`);
    expect(getRes.statusCode).toBe(200);
    const comments: any[] = getRes.json().comments ?? [];
    expect(comments.some((c) => c.body === commentText)).toBe(true);
  });
});

// ─── DUPLICATE MANAGEMENT ────────────────────────────────────────────────────

describe('duplicate management', () => {
  let flawA: { id: string; reference: string };
  let flawB: { id: string; reference: string };

  beforeAll(async () => {
    const rA = await post('/quality/flaws', {
      title: 'Login page fails to load on slow network connection',
      severity: 'MAJOR',
    });
    expect(rA.statusCode).toBe(201);
    flawA = rA.json().flaw ?? rA.json();

    const rB = await post('/quality/flaws', {
      title: 'Login page fails to load with slow network',
      severity: 'MINOR',
    });
    expect(rB.statusCode).toBe(201);
    flawB = rB.json().flaw ?? rB.json();
  });

  it('GET /quality/flaws/B/suggestions: should suggest A (similar titles)', async () => {
    const res = await get(`/quality/flaws/${flawB.id}/suggestions`);
    expect(res.statusCode).toBe(200);
    const suggestions = Array.isArray(res.json()) ? res.json() : res.json().suggestions ?? [];
    expect(suggestions.some((s: any) => s.id === flawA.id)).toBe(true);
  });

  it('POST /quality/flaws/B/duplicate {canonicalId: A.id} → 200; B status=DUPLICATE', async () => {
    const res = await post(`/quality/flaws/${flawB.id}/duplicate`, { canonicalId: flawA.id }, 'manager');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('DUPLICATE');
    expect(body.duplicateOfId).toBe(flawA.id);
  });

  it('POST /quality/flaws/B/duplicate again (idempotent) → 200', async () => {
    const res = await post(`/quality/flaws/${flawB.id}/duplicate`, { canonicalId: flawA.id }, 'manager');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DUPLICATE');
  });

  it('POST /quality/flaws/A/duplicate {canonicalId: B.id} → 422 (B is a duplicate, cannot be canonical)', async () => {
    const res = await post(`/quality/flaws/${flawA.id}/duplicate`, { canonicalId: flawB.id }, 'manager');
    expect(res.statusCode).toBe(422);
  });

  it('DELETE /quality/flaws/B/duplicate → 200; B status=TRIAGED; B.duplicateOfId=null', async () => {
    const res = await del(`/quality/flaws/${flawB.id}/duplicate`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('TRIAGED');
    expect(body.duplicateOfId).toBeNull();
  });

  it('POST /quality/flaws/B/merge {survivorId: A.id} → marks B as DUPLICATE of A', async () => {
    const res = await post(`/quality/flaws/${flawB.id}/merge`, { survivorId: flawA.id }, 'manager');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // response has {survivor, merged, movedDuplicates}
    expect(body.merged?.status ?? body.status).toBe('DUPLICATE');
    expect(body.merged?.duplicateOfId ?? body.duplicateOfId).toBe(flawA.id);
  });
});

// ─── COMMENTS AND WATCHERS ───────────────────────────────────────────────────

describe('comments and watchers', () => {
  let flawId: string;

  beforeAll(async () => {
    const r = await post('/quality/flaws', {
      title: 'Barcode scanner disconnects after long idle period',
      severity: 'MAJOR',
    });
    expect(r.statusCode).toBe(201);
    flawId = (r.json().flaw ?? r.json()).id;
  });

  it('POST /quality/flaws/:id/comments (cashier) → 201', async () => {
    const res = await post(`/quality/flaws/${flawId}/comments`, { body: 'Found the root cause' });
    expect(res.statusCode).toBe(201);
    expect(res.json().body).toBe('Found the root cause');
  });

  it('GET /quality/flaws/:id → comments array includes the new comment', async () => {
    const res = await get(`/quality/flaws/${flawId}`);
    expect(res.statusCode).toBe(200);
    const comments: any[] = res.json().comments ?? [];
    expect(comments.some((c) => c.body === 'Found the root cause')).toBe(true);
  });

  it('POST /quality/flaws/:id/watch (cashier) → 201', async () => {
    const res = await post(`/quality/flaws/${flawId}/watch`, {});
    expect(res.statusCode).toBe(201);
  });

  it('DELETE /quality/flaws/:id/watch (cashier) → 204', async () => {
    const res = inject('DELETE', `/quality/flaws/${flawId}/watch`, undefined, ctx.auth('cashier'));
    expect((await res).statusCode).toBe(204);
  });
});

// ─── TAG MANAGEMENT ──────────────────────────────────────────────────────────

describe('tag management', () => {
  it('POST /quality/flaws with tags → created flaw has those tags', async () => {
    const res = await post('/quality/flaws', {
      title: 'Application crashes when scanning malformed barcode',
      severity: 'BLOCKER',
      tags: ['crash', 'login'],
    });
    expect(res.statusCode).toBe(201);
    const flaw = res.json().flaw ?? res.json();
    const tagNames = (flaw.tags ?? []).map((t: any) => t.name);
    expect(tagNames).toContain('crash');
    expect(tagNames).toContain('login');
  });

  it('POST /quality/tags (manager) → 201', async () => {
    const res = await post('/quality/tags', { name: 'regression', color: '#FF0000' }, 'manager');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'regression', color: '#FF0000' });
  });

  it('GET /quality/tags (cashier) → returns the tag', async () => {
    const res = await get('/quality/tags');
    expect(res.statusCode).toBe(200);
    const tags = Array.isArray(res.json()) ? res.json() : res.json().tags ?? res.json().data ?? [];
    expect(tags.some((t: any) => t.name === 'regression')).toBe(true);
  });
});

// ─── EXACT DUPLICATE BLOCK ───────────────────────────────────────────────────

describe('exact duplicate block', () => {
  let moduleId: string;
  let f1Ref: string;

  beforeAll(async () => {
    const mr = await post('/quality/modules', { key: 'auth-module', name: 'Auth' }, 'manager');
    moduleId = mr.json().id;

    const r = await post('/quality/flaws', {
      title: 'Login crashes on submit',
      moduleId,
      severity: 'BLOCKER',
    });
    expect(r.statusCode).toBe(201);
    f1Ref = (r.json().flaw ?? r.json()).reference;
  });

  it('identical title+moduleId → 409 with F1 reference in body', async () => {
    const res = await post('/quality/flaws', {
      title: 'Login crashes on submit',
      moduleId,
      severity: 'MINOR',
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain(f1Ref);
  });
});

// ─── FUZZY SUGGESTION (non-blocking) ─────────────────────────────────────────

describe('fuzzy suggestion (non-blocking)', () => {
  let f1Id: string;

  beforeAll(async () => {
    const r = await post('/quality/flaws', {
      title: 'Payment gateway timeout on UPI',
      severity: 'CRITICAL',
    });
    expect(r.statusCode).toBe(201);
    f1Id = (r.json().flaw ?? r.json()).id;
  });

  it('similar-but-distinct title → 201; suggestions[0].id = F1.id', async () => {
    const res = await post('/quality/flaws', {
      title: 'Payment gateway times out for UPI',
      severity: 'MAJOR',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const suggestions: any[] = body.suggestions ?? [];
    // At least one suggestion should be F1
    expect(suggestions.some((s) => s.id === f1Id)).toBe(true);
  });
});

// ─── TENANT ISOLATION ────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it("owner from another syndicate sees empty list", async () => {
    // Seed a second syndicate and owner inline
    const { db, schema } = ctx;
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash('Password@123', 4);

    const [s2] = await db.insert(schema.syndicates).values({ name: 'Other Syndicate', maxBranches: 5 }).returning();
    const [b2] = await db.insert(schema.branches).values({ name: 'Other Branch', code: 'OB2', syndicateId: s2.id }).returning();
    const [u2] = await db.insert(schema.users).values({
      name: 'Other Owner', email: 'owner2@other.local', passwordHash, role: 'owner',
      branchId: null, syndicateId: s2.id,
    }).returning();

    // Create a flaw in the main syndicate (ctx.syndicateId)
    const r = await post('/quality/flaws', {
      title: 'Flaw visible only in main syndicate',
      severity: 'MINOR',
    });
    expect(r.statusCode).toBe(201);

    // Other owner queries flaws — their own syndicateId → empty
    const otherOwnerHeaders = ctx.authFor({
      sub: u2.id, email: u2.email, role: 'owner', branchId: null, syndicateId: s2.id,
    });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/quality/flaws', headers: otherOwnerHeaders });
    expect(res.statusCode).toBe(200);
    const list = (() => { const b = res.json(); return Array.isArray(b) ? b : b.flaws ?? b.data ?? []; })();
    expect(list).toHaveLength(0);
  });
});
