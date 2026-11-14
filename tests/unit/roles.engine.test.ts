import { describe, it, expect } from 'vitest';
import { PERMISSION_KEYS, can, defaultAllowed, discountCapPct, effectivePermissions, notGrantable, validateOverrides } from '../../src/modules/permissions/permissions.engine.js';
import {
  CUSTOM_LEVELS, PERMISSION_GROUPS, ROLE_PAGES, isCustomLevel, normalisePermissions, permissionCatalog, permissionSummary, roleKeyFromName, validateRole,
} from '../../src/modules/permissions/roles.engine.js';

describe('a custom role brings its own permissions', () => {
  it('uses the role\'s set instead of the built-in defaults', () => {
    const counterLead = ['bills.void', 'discount.unlimited'];
    expect(can('cashier', {}, 'bills.void', counterLead)).toBe(true);
    expect(can('cashier', {}, 'cost.view', counterLead)).toBe(false);
    // a manager-level custom role with a short list is NOT a full manager
    expect(can('manager', {}, 'cost.view', ['bills.void'])).toBe(false);
    expect(can('manager', {}, 'bills.void', ['bills.void'])).toBe(true);
  });

  it('built-in roles pass nothing and keep the old defaults', () => {
    expect(defaultAllowed('manager', 'cost.view')).toBe(true);
    expect(defaultAllowed('manager', 'cost.view', null)).toBe(true);
    expect(defaultAllowed('cashier', 'bills.void')).toBe(false);
    expect(defaultAllowed('steward', 'bills.void', undefined)).toBe(false);
  });

  it('a person\'s own exception still beats the role, both ways', () => {
    expect(can('cashier', { 'bills.void': false }, 'bills.void', ['bills.void'])).toBe(false);
    expect(can('cashier', { 'cost.view': true }, 'cost.view', ['bills.void'])).toBe(true);
  });

  it('owner and office admin are never restricted, whatever set they are handed', () => {
    for (const role of ['owner', 'office_admin']) {
      expect(effectivePermissions(role, {}, [])).toEqual(Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])));
      expect(can(role, { 'bills.void': false }, 'bills.void', [])).toBe(true);
    }
  });

  it('the discount cap follows the role: lifted only when the role grants it', () => {
    expect(discountCapPct('cashier', {}, ['bills.void'])).toBe(5);
    expect(discountCapPct('cashier', {}, ['discount.unlimited'])).toBeNull();
    expect(discountCapPct('manager', {})).toBeNull();
  });

  it('nobody can hand out what their own role does not give them', () => {
    expect(notGrantable('manager', {}, { 'cost.view': true, 'bills.void': true }, ['bills.void'])).toEqual(['cost.view']);
    expect(notGrantable('manager', {}, { 'bills.void': true })).toEqual([]);                    // a built-in manager holds everything
    expect(notGrantable('manager', { 'cost.view': true }, { 'cost.view': true }, ['bills.void'])).toEqual([]);   // …or was given it personally
  });

  it('keeps the approve-needs-cost rule for a person on a custom role', () => {
    expect(validateOverrides('cashier', { 'invoices.approve': true }, ['bills.void']).join(' ')).toMatch(/cost prices/);
    expect(validateOverrides('cashier', { 'invoices.approve': true }, ['cost.view'])).toEqual([]);
  });
});

describe('validateRole', () => {
  const ok = { name: 'Counter Lead', level: 'cashier', permissions: ['bills.void'], pages: ['pos', 'bills'] };
  it('accepts a sensible role', () => expect(validateRole(ok)).toEqual([]));
  it('allows steward, cashier and manager levels only', () => {
    expect([...CUSTOM_LEVELS]).toEqual(['steward', 'cashier', 'manager']);
    expect(isCustomLevel('manager')).toBe(true);
    for (const level of ['office_admin', 'owner', 'god']) {
      expect(validateRole({ ...ok, level }).join(' ')).toMatch(/steward, cashier or manager/);
    }
  });
  it('rejects unknown permissions and pages', () => {
    expect(validateRole({ ...ok, permissions: ['bills.void', 'teleport'] }).join(' ')).toMatch(/Unknown permission: teleport/);
    expect(validateRole({ ...ok, pages: ['pos', 'platform'] }).join(' ')).toMatch(/Unknown page: platform/);
  });
  it('approving invoices needs seeing costs', () => {
    expect(validateRole({ ...ok, permissions: ['invoices.approve'] }).join(' ')).toMatch(/also needs "See cost prices"/);
    expect(validateRole({ ...ok, permissions: ['invoices.approve', 'cost.view'] })).toEqual([]);
  });
  it('null pages means "whatever the level allows" and is fine', () => expect(validateRole({ ...ok, pages: null })).toEqual([]));
});

describe('catalog and helpers', () => {
  it('shows every permission in exactly one group', () => {
    const inGroups = PERMISSION_GROUPS.flatMap((g) => g.keys);
    expect([...inGroups].sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(new Set(inGroups).size).toBe(inGroups.length);
    expect(permissionCatalog().flatMap((g) => g.permissions.map((p) => p.key)).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
  it('never offers Business Settings or the Platform console as a role page', () => {
    const keys = ROLE_PAGES.map((p) => p.key);
    expect(keys).not.toContain('settings');
    expect(keys).not.toContain('platform');
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('normalises a permission list into a stable order without duplicates or unknowns', () => {
    expect(normalisePermissions(['stock.move', 'cost.view', 'cost.view', 'nope'])).toEqual(['cost.view', 'stock.move']);
  });
  it('makes a readable key from a role name', () => {
    expect(roleKeyFromName('Counter Lead!')).toBe('counter_lead');
    expect(roleKeyFromName('  Bar & Grill  ')).toBe('bar_grill');
    expect(roleKeyFromName('???')).toBe('role');
  });
  it('summarises how much a role grants', () => {
    expect(permissionSummary(['bills.void', 'cost.view', 'bogus'])).toEqual({ granted: 2, total: PERMISSION_KEYS.length });
  });
});
