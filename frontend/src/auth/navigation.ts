import { PAGE_PERMISSION, pageDisabled } from '../lib/features';
import { userCan, saasRoleOf, type User, type SaasRole } from './AuthProvider';
import {
  LayoutDashboard,
  ShoppingCart,
  Clock,
  Receipt,
  Users,
  Coffee,
  Wine,
  Package,
  FileUp,
  UtensilsCrossed,
  GlassWater,
  ClipboardList,
  Droplets,
  Target,
  ShieldCheck,
  BookOpen,
  Landmark,
  Lock,
  Settings,
  Building2,
  Globe,
  UserCog,
  ScrollText,
  Bug,
  CreditCard,
  GitBranch,
  KeyRound,
  Database,
} from 'lucide-react';
export type NavItem = {
  path: string;
  label: string;
  icon: typeof Wine;
  id: string;
  min: 'steward' | 'cashier' | 'office_admin' | 'manager' | 'owner';
  group: string;
  pageKey: string;
  /** Restrict an item to one SaaS role (e.g. the Platform console is Super Admin only). */
  only?: SaasRole;
};

export const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, id: 'nav-dashboard', min: 'steward', group: 'Daily work', pageKey: 'dashboard' },

  { path: '/pos', label: 'Billing (POS)', icon: ShoppingCart, id: 'nav-pos', min: 'cashier', group: 'Daily work', pageKey: 'pos' },
  { path: '/shift', label: 'Cashier Shift', icon: Clock, id: 'nav-shift', min: 'cashier', group: 'Daily work', pageKey: 'shift' },
  { path: '/bills', label: 'Bills', icon: Receipt, id: 'nav-bills', min: 'cashier', group: 'Daily work', pageKey: 'bills' },
  { path: '/tables', label: 'Tables & Orders (KOT)', icon: Coffee, id: 'nav-tables', min: 'steward', group: 'Bar service', pageKey: 'tables' },
  { path: '/customers', label: 'Customers & Khata', icon: Users, id: 'nav-customers', min: 'cashier', group: 'Daily work', pageKey: 'customers' },

  { path: '/menu/kitchen', label: 'Kitchen Menu', icon: UtensilsCrossed, id: 'nav-menu-kitchen', min: 'steward', group: 'Bar service', pageKey: 'menu/kitchen' },
  { path: '/menu/bar', label: 'Bar Menu', icon: GlassWater, id: 'nav-menu-bar', min: 'steward', group: 'Bar service', pageKey: 'menu/bar' },
  { path: '/products', label: 'Products', icon: Wine, id: 'nav-products', min: 'cashier', group: 'Stock & purchases', pageKey: 'products' },
  { path: '/invoices', label: 'Supplier Invoices', icon: FileUp, id: 'nav-invoices', min: 'cashier', group: 'Stock & purchases', pageKey: 'inventory' },
  { path: '/inventory', label: 'Inventory', icon: Package, id: 'nav-inventory', min: 'cashier', group: 'Stock & purchases', pageKey: 'inventory' },
  { path: '/counter', label: 'Counter Stock Sheet', icon: ClipboardList, id: 'nav-counter', min: 'cashier', group: 'Stock & purchases', pageKey: 'counter' },
  { path: '/pour', label: 'Peg Control', icon: Droplets, id: 'nav-pour', min: 'manager', group: 'Bar service', pageKey: 'pour' },

  { path: '/schemes', label: 'Supplier Schemes', icon: Target, id: 'nav-schemes', min: 'manager', group: 'Accounts & closing', pageKey: 'schemes' },
  { path: '/compliance', label: 'Excise & Breakage', icon: ShieldCheck, id: 'nav-compliance', min: 'manager', group: 'Accounts & closing', pageKey: 'compliance' },
  { path: '/accounting', label: 'Accounting', icon: BookOpen, id: 'nav-accounting', min: 'manager', group: 'Accounts & closing', pageKey: 'accounting' },
  { path: '/bank', label: 'Match Bank Statement', icon: Landmark, id: 'nav-bank', min: 'manager', group: 'Accounts & closing', pageKey: 'bank' },
  { path: '/closing', label: 'Day Closing', icon: Lock, id: 'nav-closing', min: 'manager', group: 'Accounts & closing', pageKey: 'closing' },

  { path: '/admin', label: 'Staff & Billing Counters', icon: Settings, id: 'nav-admin', min: 'manager', group: 'Staff & settings', pageKey: 'admin' },
  { path: '/settings', label: 'Business Settings', icon: Building2, id: 'nav-settings', min: 'owner', group: 'Staff & settings', pageKey: 'settings' },

  { path: '/platform', label: 'Platform Console', icon: Globe, id: 'nav-platform', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/roles', label: 'Roles & Permissions', icon: KeyRound, id: 'nav-platform-roles', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/branches', label: 'Branches', icon: GitBranch, id: 'nav-platform-branches', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/plans', label: 'Plans & Billing', icon: CreditCard, id: 'nav-platform-plans', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/users', label: 'Users', icon: UserCog, id: 'nav-platform-users', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/master', label: 'Master Catalog', icon: Database, id: 'nav-platform-master', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/audit', label: 'Audit Log', icon: ScrollText, id: 'nav-platform-audit', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
  { path: '/platform/errors', label: 'Errors', icon: Bug, id: 'nav-platform-errors', min: 'owner', group: 'Platform', only: 'super_admin', pageKey: 'platform' },
];

// Office Admin runs the business for the owner: above a manager, below the owner (platform / business settings stay owner-only)
const roleRank = { steward: 1, cashier: 2, manager: 3, office_admin: 3.5, owner: 4 };

export function canOpenPage(user: User, path: string, disabledFeatures: string[] = []): boolean {
  const item = navItems.find((entry) => entry.path === path);
  if (!item) return false;
  if (saasRoleOf(user) === 'super_admin') return item.only === 'super_admin';
  if (item.only === 'super_admin' || pageDisabled(path, disabledFeatures)) return false;
  if (user.role === 'owner') return true;
  if (item.min === 'owner') return false;
  const needs = PAGE_PERMISSION[path];
  if (needs ? !userCan(user, needs) : roleRank[user.role] < roleRank[item.min]) return false;
  const alias = item.pageKey === 'inventory' ? 'stock' : item.pageKey === 'compliance' ? 'reports' : '';
  const override = user.pages?.find((p) => p.routePath === item.pageKey || p.routePath === path.slice(1) || (alias && p.routePath === alias));
  return override?.canAccess ?? true;
}

export function visibleNavigation(user: User, disabledFeatures: string[] = []): NavItem[] {
  const preferred = user.role === 'steward' ? '/tables' : user.role === 'cashier' ? '/pos' : '/';
  const managesAccounts = ['manager', 'office_admin', 'owner'].includes(user.role);
  const priority = (item: NavItem) => item.path === preferred ? 0 : managesAccounts && item.group === 'Accounts & closing' ? 1 : 2;
  return navItems.filter((item) => canOpenPage(user, item.path, disabledFeatures))
    .sort((a, b) => priority(a) - priority(b));
}

/** Never send a restricted user back to another restricted page. */
export function defaultPage(user: User, disabledFeatures: string[] = []): string | null {
  return visibleNavigation(user, disabledFeatures)[0]?.path ?? null;
}
