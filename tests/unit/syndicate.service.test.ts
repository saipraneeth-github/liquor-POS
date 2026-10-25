import { describe, it, expect, vi } from 'vitest';
import { listSyndicates, getSyndicateBranches, createSyndicate } from '../../src/modules/syndicates/syndicate.service.js';
import { db } from '../../src/db/client.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'syndicate-1', name: 'Test Syndicate' }]),
  },
}));

describe('syndicate.service', () => {
  it('lists all syndicates for the platform scope', async () => {
    vi.mocked(db.orderBy).mockResolvedValueOnce([{ id: '1', name: 'S1' }] as any);
    const rows = await listSyndicates('ALL');
    expect(rows).toEqual([{ id: '1', name: 'S1' }]);
  });

  it('restricts the list to one syndicate for a syndicate owner', async () => {
    vi.mocked(db.where).mockResolvedValueOnce([{ id: 's2' }] as any);
    const rows = await listSyndicates('s2');
    expect(rows).toEqual([{ id: 's2' }]);
    expect(db.where).toHaveBeenCalled();
  });

  it('fetches branches by syndicate ID to enforce multi-tenant isolation', async () => {
    const branches = await getSyndicateBranches('syndicate-1');
    expect(branches.length).toBe(2);
    expect(db.where).toHaveBeenCalled();
  });

  it('creates a new syndicate', async () => {
    const created = await createSyndicate({ name: 'Test Syndicate', gstin: '22AAAAA0000A1Z5' });
    expect(created).toEqual({ id: 'syndicate-1', name: 'Test Syndicate' });
    expect(db.values).toHaveBeenCalledWith({ name: 'Test Syndicate', gstin: '22AAAAA0000A1Z5' });
  });
});
