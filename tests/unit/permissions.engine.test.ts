import { describe, expect, it } from 'vitest';
import {
  DISCOUNT_CAP_PCT, can, defaultAllowed, discountCapPct, discountWithinCap, effectivePermissions, isUnrestricted,
  notGrantable, saleTypeAllowed, validateOverrides,
} from '../../src/modules/permissions/permissions.engine.js';
import { assertCanAssignRole, canManageUser } from '../../src/modules/users/user.engine.js';

describe('role defaults', () => {
  it('owner and office admin always have everything and cannot be restricted', () => {
    for (const role of ['owner', 'office_admin']) {
      expect(isUnrestricted(role)).toBe(true);
      expect(can(role, { 'prices.edit': false }, 'prices.edit')).toBe(true);
      expect(Object.values(effectivePermissions(role, {})).every(Boolean)).toBe(true);
    }
  });
  it('manager has everything by default, cashier and steward nothing', () => {
    expect(Object.values(effectivePermissions('manager', {})).every(Boolean)).toBe(true);
    for (const role of ['cashier', 'steward']) expect(Object.values(effectivePermissions(role, {})).some(Boolean)).toBe(false);
    expect(defaultAllowed('cashier', 'cost.view')).toBe(false);
  });
  it('a single action can be granted to a cashier or taken from a manager', () => {
    expect(can('cashier', { 'bills.void': true }, 'bills.void')).toBe(true);
    expect(can('cashier', { 'bills.void': true }, 'prices.edit')).toBe(false);
    expect(can('manager', { 'prices.edit': false }, 'prices.edit')).toBe(false);
    expect(can('manager', { 'prices.edit': false }, 'bills.void')).toBe(true);
  });
});

describe('discount cap', () => {
  it('is 5% unless the user may give more', () => {
    expect(DISCOUNT_CAP_PCT).toBe(5);
    expect(discountCapPct('cashier', {})).toBe(5);
    expect(discountCapPct('cashier', { 'discount.unlimited': true })).toBeNull();
    expect(discountCapPct('manager', {})).toBeNull();
    expect(discountCapPct('manager', { 'discount.unlimited': false })).toBe(5);
    expect(discountCapPct('office_admin', {})).toBeNull();
  });
  it('is exact to the paisa', () => {
    expect(discountWithinCap('50.00', '1000.00', 5)).toBe(true);       // exactly 5%
    expect(discountWithinCap('50.01', '1000.00', 5)).toBe(false);
    expect(discountWithinCap('0', '1000.00', 5)).toBe(true);
    expect(discountWithinCap('1.11', '22.20', 5)).toBe(true);          // 1.11 = 5% of 22.20
    expect(discountWithinCap('1.12', '22.20', 5)).toBe(false);
    expect(discountWithinCap('999999', '1', null)).toBe(true);         // no cap
  });
});

describe('sale type access', () => {
  it('only cashiers and stewards can be limited; no list = no limit', () => {
    expect(saleTypeAllowed('cashier', ['j'], 'j')).toBe(true);
    expect(saleTypeAllowed('cashier', ['j'], 'w')).toBe(false);
    expect(saleTypeAllowed('cashier', [], 'w')).toBe(true);
    expect(saleTypeAllowed('cashier', null, 'w')).toBe(true);
    expect(saleTypeAllowed('manager', ['j'], 'w')).toBe(true);
    expect(saleTypeAllowed('office_admin', ['j'], 'w')).toBe(true);
  });
});

describe('granting', () => {
  it('nobody can hand out a permission they do not hold', () => {
    expect(notGrantable('manager', { 'cost.view': false }, { 'cost.view': true, 'bills.void': true })).toEqual(['cost.view']);
    expect(notGrantable('office_admin', {}, { 'cost.view': true })).toEqual([]);
  });
  it('rejects nonsense combinations', () => {
    expect(validateOverrides('cashier', { 'invoices.approve': true })).toHaveLength(1);        // approval needs cost.view
    expect(validateOverrides('cashier', { 'invoices.approve': true, 'cost.view': true })).toEqual([]);
    expect(validateOverrides('office_admin', { 'prices.edit': false })).toHaveLength(1);
  });
});

describe('who manages whom', () => {
  it('office admin sits between owner and manager', () => {
    expect(canManageUser({ id: 'a', role: 'office_admin' }, { id: 'b', role: 'manager' })).toBe(true);
    expect(canManageUser({ id: 'a', role: 'manager' }, { id: 'b', role: 'office_admin' })).toBe(false);
    expect(canManageUser({ id: 'a', role: 'office_admin' }, { id: 'b', role: 'office_admin' })).toBe(false);
    expect(canManageUser({ id: 'a', role: 'owner' }, { id: 'b', role: 'office_admin' })).toBe(true);
  });
  it('a manager cannot create an office admin (that would be owner-level power)', () => {
    expect(() => assertCanAssignRole('manager', 'office_admin')).toThrow();
    expect(() => assertCanAssignRole('manager', 'cashier')).not.toThrow();
    expect(() => assertCanAssignRole('office_admin', 'manager')).not.toThrow();
    expect(() => assertCanAssignRole('office_admin', 'office_admin')).toThrow();
    expect(() => assertCanAssignRole('office_admin', 'owner')).toThrow();
    expect(() => assertCanAssignRole('owner', 'office_admin')).not.toThrow();
  });
});
