import { describe, it, expect, vi } from 'vitest';
import { SyndicateService } from '../../src/modules/syndicates/syndicate.service.js';
import { db } from '../../src/db/client.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'syndicate-1', name: 'Test Syndicate' }])
  }
}));

describe('SyndicateService', () => {
  it('should list all syndicates', async () => {
    const service = new SyndicateService();
    // Simulate list response
    vi.mocked(db.from).mockResolvedValueOnce([{ id: '1', name: 'S1' }] as any);

    const syndicates = await service.listSyndicates();
    expect(syndicates).toEqual([{ id: '1', name: 'S1' }]);
  });

  it('should fetch branches by syndicate ID to enforce multi-tenant isolation', async () => {
    const service = new SyndicateService();
    const branches = await service.getSyndicateBranches('syndicate-1');
    expect(branches.length).toBe(2);
    expect(db.where).toHaveBeenCalled();
  });

  it('should create a new syndicate', async () => {
    const service = new SyndicateService();
    const newSyndicate = await service.createSyndicate({
      name: 'Test Syndicate',
      gstin: '22AAAAA0000A1Z5'
    });

    expect(newSyndicate).toEqual({ id: 'syndicate-1', name: 'Test Syndicate' });
    expect(db.insert).toHaveBeenCalled();
    expect(db.values).toHaveBeenCalledWith({
      name: 'Test Syndicate',
      gstin: '22AAAAA0000A1Z5'
    });
  });
});
