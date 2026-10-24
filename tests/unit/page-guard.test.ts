import { describe, it, expect, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { pageGuard } from '../../src/modules/auth/page-guard.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn()
  }
}));

vi.mock('../../src/db/schema.js', () => ({
  userPagePermissions: { userId: 'userId', routePath: 'routePath' },
  users: {}
}));

describe('pageGuard', () => {
  it('returns 401 if user is not authenticated', async () => {
    const req = { user: undefined } as any;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnValue('UnauthorizedResponse')
    } as any;

    const result = await pageGuard(req, reply, 'dashboard');
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(result).toBe('UnauthorizedResponse');
  });

  it('returns 403 if user role is not in allowedRoles list', async () => {
    const req = { user: { id: 'u1', role: 'cashier' } } as any;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnValue('ForbiddenRoleResponse')
    } as any;

    const result = await pageGuard(req, reply, 'dashboard', ['owner', 'manager']);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden: Insufficient role' });
    expect(result).toBe('ForbiddenRoleResponse');
  });

  it('returns 403 if route permission matrix explicitly denies access', async () => {
    const req = { user: { id: 'u1', role: 'manager' } } as any;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnValue('ForbiddenMatrixResponse')
    } as any;

    // Mock DB returning canAccess = false
    vi.mocked(db.limit).mockResolvedValueOnce([{ canAccess: false }] as any);

    const result = await pageGuard(req, reply, 'syndicate-settings', ['manager']);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden: Missing page access permission' });
    expect(result).toBe('ForbiddenMatrixResponse');
  });

  it('allows access if role matches and route permission is true', async () => {
    const req = { user: { id: 'u1', role: 'manager' } } as any;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn()
    } as any;

    // Mock DB returning canAccess = true
    vi.mocked(db.limit).mockResolvedValueOnce([{ canAccess: true }] as any);

    const result = await pageGuard(req, reply, 'syndicate-settings', ['manager']);

    // Should NOT send error response, allowing fastify preHandler to pass to next
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
