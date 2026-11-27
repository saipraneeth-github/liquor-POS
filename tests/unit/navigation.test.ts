import { describe, expect, it } from 'vitest';
import { canOpenPage, defaultPage, navItems, visibleNavigation } from '../../frontend/src/auth/navigation';
import type { User } from '../../frontend/src/auth/AuthProvider';
import { MESSAGES } from '../../frontend/src/i18n/messages';

const person = (role: User['role'], extra: Partial<User> = {}): User => ({
  id: 'staff', name: 'Staff', email: 'staff@example.test', role, syndicateId: 'shop', ...extra,
});

describe('role navigation', () => {
  it('puts accounts before stock and bar menus for management', () => {
    const items = visibleNavigation(person('office_admin'));
    expect(items.findIndex((p) => p.path === '/accounting')).toBeLessThan(items.findIndex((p) => p.path === '/inventory'));
    expect(items.findIndex((p) => p.path === '/bank')).toBeLessThan(items.findIndex((p) => p.path === '/tables'));
  });
  it.each([
    ['steward', '/tables'], ['cashier', '/pos'], ['manager', '/'], ['office_admin', '/'], ['owner', '/'],
  ] as const)('starts %s on %s', (role, path) => expect(defaultPage(person(role))).toBe(path));

  it('keeps platform and shop menus separate', () => {
    const platform = person('owner', { syndicateId: null, branchId: null });
    expect(defaultPage(platform)).toBe('/platform');
    expect(visibleNavigation(platform).every((p) => p.path.startsWith('/platform'))).toBe(true);
    expect(canOpenPage(person('owner'), '/platform/master')).toBe(false);
  });

  it('honours page restrictions and chooses an accessible fallback', () => {
    const cashier = person('cashier', { pages: [{ routePath: 'pos', canAccess: false }] });
    expect(canOpenPage(cashier, '/pos')).toBe(false);
    expect(defaultPage(cashier)).toBe('/');
    expect(defaultPage(person('steward'), ['bar'])).toBe('/');
  });

  it('does not let page grants bypass role or action requirements', () => {
    const cashier = person('cashier', { pages: [{ routePath: 'admin', canAccess: true }, { routePath: 'inventory', canAccess: true }] });
    expect(canOpenPage(cashier, '/admin')).toBe(false);
    expect(canOpenPage(cashier, '/invoices')).toBe(false);
    expect(canOpenPage({ ...cashier, permissions: { 'cost.view': true } }, '/invoices')).toBe(true);
    expect(canOpenPage(person('office_admin'), '/settings')).toBe(false);
    expect(canOpenPage(person('office_admin'), '/admin')).toBe(true);
  });

  it('returns no landing page instead of looping when every page is hidden', () => {
    const pages = navItems.map((p) => ({ routePath: p.pageKey, canAccess: false }));
    expect(defaultPage(person('cashier', { pages }))).toBeNull();
  });

  it('retains owner access while respecting branch feature switches', () => {
    expect(canOpenPage(person('owner'), '/bank', ['bank'])).toBe(false);
    expect(canOpenPage(person('owner', { pages: [{ routePath: 'pos', canAccess: false }] }), '/pos')).toBe(true);
  });

  it('translates every new shop menu group', () => {
    for (const group of new Set(navItems.filter((p) => !p.only).map((p) => p.group))) {
      expect(MESSAGES.hi[group]).toBeTruthy();
      expect(MESSAGES.te[group]).toBeTruthy();
    }
  });
});
