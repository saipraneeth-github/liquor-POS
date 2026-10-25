import { describe, it, expect } from 'vitest';
import {
  assignableRoles,
  assertCanAssignRole,
  canManageUser,
  assertUserPatchAllowed,
} from '../../src/modules/users/user.engine.js';

const owner = { id: 'o', role: 'owner' };
const manager = { id: 'm', role: 'manager' };
const cashier = { id: 'c', role: 'cashier', branchId: 'b1' };

describe('role assignment', () => {
  it('owner can assign any role; manager only cashier/steward; others none', () => {
    expect(assignableRoles('owner')).toHaveLength(4);
    expect(assignableRoles('manager')).toEqual(['cashier', 'steward']);
    expect(assignableRoles('cashier')).toEqual([]);
  });

  it('manager cannot create a manager or owner', () => {
    expect(() => assertCanAssignRole('manager', 'manager')).toThrow();
    expect(() => assertCanAssignRole('manager', 'owner')).toThrow();
    expect(() => assertCanAssignRole('manager', 'steward')).not.toThrow();
  });
});

describe('canManageUser', () => {
  it('managers manage only lower ranks and never themselves', () => {
    expect(canManageUser(manager, cashier)).toBe(true);
    expect(canManageUser(manager, { id: 'm2', role: 'manager' })).toBe(false);
    expect(canManageUser(manager, manager)).toBe(false);
  });

  it('owners manage anyone but themselves', () => {
    expect(canManageUser(owner, { id: 'o2', role: 'owner' })).toBe(true);
    expect(canManageUser(owner, owner)).toBe(false);
  });
});

describe('assertUserPatchAllowed', () => {
  it('self may only rename', () => {
    const self = { ...manager, branchId: 'b1' };
    expect(() => assertUserPatchAllowed(manager, self, { name: 'New' })).not.toThrow();
    expect(() => assertUserPatchAllowed(manager, self, { role: 'owner' })).toThrow('own role');
    expect(() => assertUserPatchAllowed(manager, self, { isActive: false })).toThrow('own active status');
  });

  it('manager cannot elevate a cashier above cashier/steward', () => {
    expect(() => assertUserPatchAllowed(manager, cashier, { role: 'manager' })).toThrow();
    expect(() => assertUserPatchAllowed(manager, cashier, { role: 'steward', isActive: false })).not.toThrow();
  });

  it('manager cannot touch another manager', () => {
    expect(() => assertUserPatchAllowed(manager, { id: 'm2', role: 'manager', branchId: 'b1' }, { isActive: false }))
      .toThrow('at or above');
  });

  it('branch-less owner cannot be demoted', () => {
    expect(() => assertUserPatchAllowed(owner, { id: 'o2', role: 'owner', branchId: null }, { role: 'manager' }))
      .toThrow('branch-less owner');
  });
});
