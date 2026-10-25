import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../../src/db/client.js';
import { requirePage } from '../../src/modules/auth/page-guard.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  },
}));

vi.mock('../../src/db/schema.js', () => ({
  userPagePermissions: { userId: 'userId', routePath: 'routePath', canAccess: 'canAccess' },
  users: {},
  branches: {},
}));

function makeReq(user: unknown, verifyOk = true) {
  return {
    user,
    jwtVerify: verifyOk ? vi.fn().mockResolvedValue(user) : vi.fn().mockRejectedValue(new Error('bad token')),
  } as any;
}

function makeReply() {
  return { code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() } as any;
}

describe('requirePage', () => {
  beforeEach(() => {
    vi.mocked(db.limit).mockReset();
  });

  it('returns 401 when the JWT cannot be verified', async () => {
    const reply = makeReply();
    await requirePage('pos')(makeReq(undefined, false), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 401 when the token has no subject', async () => {
    const reply = makeReply();
    await requirePage('pos')(makeReq({ role: 'manager' }), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('returns 403 when the role is below minRole', async () => {
    const reply = makeReply();
    await requirePage('reports', 'manager')(makeReq({ sub: 'u1', role: 'cashier' }), reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden: Insufficient role' });
    expect(db.limit).not.toHaveBeenCalled();
  });

  it('lets owners bypass the permission matrix', async () => {
    const reply = makeReply();
    await requirePage('settings')(makeReq({ sub: 'o1', role: 'owner' }), reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(db.limit).not.toHaveBeenCalled();
  });

  it('returns 403 when no permission row exists', async () => {
    vi.mocked(db.limit).mockResolvedValueOnce([] as any);
    const reply = makeReply();
    await requirePage('inventory')(makeReq({ sub: 'u1', role: 'manager' }), reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden: Missing page access permission' });
  });

  it('returns 403 when the matrix explicitly denies access', async () => {
    vi.mocked(db.limit).mockResolvedValueOnce([{ canAccess: false }] as any);
    const reply = makeReply();
    await requirePage('accounting', 'manager')(makeReq({ sub: 'u1', role: 'manager' }), reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it('allows access when the role matches and canAccess is true (uses JWT sub)', async () => {
    vi.mocked(db.limit).mockResolvedValueOnce([{ canAccess: true }] as any);
    const reply = makeReply();
    await requirePage('pos', 'cashier')(makeReq({ sub: 'u1', role: 'cashier' }), reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    expect(db.where).toHaveBeenCalled();
  });
});
