import { navItems, visibleNavigation, canOpenPage, defaultPage } from '../auth/navigation';
import { useEffect, useRef, useState } from 'react';
import { useDesktopViewport } from '../lib/useDesktopViewport';
import { useOverlayFocus } from '../lib/useOverlayFocus';
import { Outlet, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, type SaasRole } from '../auth/AuthProvider';
import { useTheme } from '../context/ThemeContext';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { Field, Modal } from './ui';
import { ErrorBoundary } from './ErrorBoundary';
import { LanguageSwitcher, useT } from '../i18n';
import { Wine, LogOut, Sun, Moon, Menu, X, PanelLeftClose } from 'lucide-react';


const ROLE_LABEL: Record<SaasRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  office_admin: 'Office Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  steward: 'Steward',
};

export function Layout() {
  const { user, logout, saasRole, branches, activeBranchId, setActiveBranch, disabledFeatures } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { t } = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [showSignoutWarning, setShowSignoutWarning] = useState(false);
  const [dueAmount, setDueAmount] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lc_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktop = useDesktopViewport();
  const mobileDrawerOpen = !desktop && mobileOpen;
  const drawerVisible = desktop ? !isCollapsed : mobileDrawerOpen;
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  useOverlayFocus(mobileDrawerOpen, sidebarRef, sidebarCloseRef, navToggleRef);
  const [pwOpen, setPwOpen] = useState(false);
  // After an administrator reset the app is unusable until the person picks their own password (the server refuses every other call)
  const pwForced = !!user?.mustChangePassword;
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState<string | null>(null);

  const toggleSidebar = () => {
    if (window.innerWidth < 768) {
      if (mobileOpen) closeSidebar();
      else setMobileOpen(true);
    } else {
      setIsCollapsed((prev) => {
        const next = !prev;
        try {
          localStorage.setItem('lc_sidebar_collapsed', String(next));
        } catch {}
        return next;
      });
    }
  };

  const closeSidebar = () => {
    if (window.innerWidth < 768) {
      setMobileOpen(false);
    } else {
      navToggleRef.current?.focus();
      setIsCollapsed(true);
      try {
        localStorage.setItem('lc_sidebar_collapsed', 'true');
      } catch {}
    }
  };

  // A Super Admin "support sign-in" keeps the original token so there is a way back
  const supportLabel = localStorage.getItem('support_label');
  const exitSupport = async () => {
    let next: string | null = null;
    try {
      next = (await api.post<{ token: string }>('/auth/support-return')).token;
    } catch {
      // the 30 minute support token ended, or that Super Admin can no longer sign back in: go to sign-in
    }
    localStorage.removeItem('support_return_token');   // older versions kept the Super Admin token here
    localStorage.removeItem('support_label');
    localStorage.removeItem('activeBranchId');
    if (next) localStorage.setItem('token', next); else { localStorage.removeItem('token'); localStorage.removeItem('user'); }
    window.location.assign(next ? '/platform' : '/login');
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    try {
      const res = await api.post<{ token?: string }>('/auth/change-password', { currentPassword: pw.current, newPassword: pw.next });
      if (res?.token) localStorage.setItem('token', res.token);   // the old token ended with the change
      showToast('Password changed.');
      setPwOpen(false);
      setPw({ current: '', next: '' });
      if (pwForced) window.location.reload();   // reload with the new token and a profile that no longer asks
    } catch (err) {
      setPwError(errorMessage(err));
    }
  };

  // Keyboard shortcut Ctrl+B / Cmd+B to toggle sidebar, Escape to close on mobile
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('#cartPanel[aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.key === 'Escape') {
        if (mobileOpen && window.innerWidth < 768) closeSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen]);

  useEffect(() => {
    if (saasRole !== 'admin') return;
    api.get<{ invoices: { status: string; amount: string }[] }>('/tenant/invoices')
      .then((r) => setDueAmount(r.invoices.find((i) => i.status === 'PENDING')?.amount ?? null))
      .catch(() => setDueAmount(null));
  }, [saasRole, location.pathname]);

  if (!user) return null;

  const sub = (user as any)?.sub ?? user?.id ?? '';
  const activeBranch = branches.find((b) => b.id === activeBranchId);

  const getPendingQueueCount = (): number => {
    try {
      const q = JSON.parse(localStorage.getItem(`lc_offline_bills:${sub}`) || '[]');
      return q.length;
    } catch {
      return 0;
    }
  };

  const handleLogoutClick = () => {
    const pending = getPendingQueueCount();
    if (pending > 0) {
      setShowSignoutWarning(true);
      return;
    }
    doLogout();
  };

  const doLogout = () => {
    setShowSignoutWarning(false);
    logout();
    navigate('/login');
  };

  const items = visibleNavigation(user, disabledFeatures);
  if (!canOpenPage(user, location.pathname, disabledFeatures)) {
    const landing = defaultPage(user, disabledFeatures);
    if (landing) return <Navigate to={landing} replace />;
    return <div className="p-6"><p>{t('No pages are available. Ask your manager to check your access.')}</p><button className="min-h-11 underline" onClick={doLogout}>{t('Sign out')}</button></div>;
  }
  const groups = [...new Set(items.map((i) => i.group))];
  const pageTitle = t(navItems.find((i) => i.path === location.pathname)?.label || '');

  return (
    <div className="flex h-dvh bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors" id="mainApp">
      {mobileDrawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 md:hidden backdrop-blur-xs transition-opacity"
          onClick={closeSidebar}
        />
      )}
      <aside
        id="appSidebar"
        ref={sidebarRef}
        inert={!drawerVisible}
        role={mobileDrawerOpen ? 'dialog' : undefined}
        aria-modal={mobileDrawerOpen || undefined}
        aria-label={mobileDrawerOpen ? 'Navigation menu' : undefined}
        onClick={(e) => {
          if (window.innerWidth < 768 && (e.target as HTMLElement).closest('a')) {
            closeSidebar();
          }
        }}
        className={`fixed inset-y-0 left-0 z-40 bg-[#0e2a21] dark:bg-[#0c2219] text-[#e7f0eb] border-r border-white/5 flex flex-col transition-all duration-300 ease-in-out md:static ${
          mobileOpen ? 'translate-x-0 w-64 shadow-2xl' : '-translate-x-full md:translate-x-0'
        } ${
          isCollapsed
            ? 'md:w-0 md:opacity-0 md:border-r-0 md:pointer-events-none overflow-hidden'
            : 'md:w-64 md:opacity-100'
        }`}
      >
        <div className="w-64 flex flex-col h-full shrink-0">
          <div className="p-4 text-xl border-b border-white/10 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="grid place-items-center size-9 rounded-lg bg-white/10 shrink-0"><Wine size={20} className="text-[#dda64a]" /></span>
              <div className="min-w-0">
                <div className="font-display font-bold tracking-tight truncate">Liquor Counter</div>
                <div className="text-xs font-normal text-[#9db7ac] truncate" id="sidebarBranch">
                  {saasRole === 'super_admin' ? 'Platform HQ' : activeBranch ? `${activeBranch.code} — ${activeBranch.name}` : 'MAIN-01 — Main Counter Branch'}
                </div>
              </div>
            </div>
            <button
              type="button"
              id="sidebarCloseBtn"
              ref={sidebarCloseRef}
              aria-label="Close navigation sidebar"
              title="Close sidebar (Ctrl+B)"
              onClick={closeSidebar}
              className="p-1.5 rounded-lg text-[#9db7ac] hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            >
              <PanelLeftClose size={18} className="hidden md:block" />
              <X size={18} className="md:hidden" />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto p-4 space-y-4">
            {groups.map((group) => (
              <div key={group} className="space-y-1">
                {groups.length > 1 && (
                  <div className="px-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7f9b8f]">{t(group)}</div>
                )}
                {items.filter((i) => i.group === group).map((item) => {
                  const Icon = item.icon;
                  const isActive = location.pathname === item.path;
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      id={item.id}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex min-h-11 items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                        isActive
                          ? 'bg-white/12 text-white font-semibold shadow-[inset_3px_0_0_#dda64a]'
                          : 'text-[#c4d6cd] hover:bg-white/6 hover:text-white'
                      }`}
                    >
                      <Icon size={18} className="shrink-0" aria-hidden="true" />
                      <span className="min-w-0 break-words">{t(item.label)}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="p-4 border-t border-white/10 space-y-2">
            <div className="mb-2 text-sm">
              <div id="userDisplay" className="font-semibold">{user.name} ({saasRole ? ROLE_LABEL[saasRole] : user.role})</div>
              <div id="emailDisplay" className="text-[#9db7ac] text-xs truncate">{user.email}</div>
            </div>
            <button
              type="button"
              id="changePasswordBtn"
              onClick={() => { setPwError(null); setPwOpen(true); }}
              className="w-full text-left px-2 py-1 text-xs text-[#c4d6cd] hover:text-white hover:underline cursor-pointer"
            >
              Change password
            </button>
            <button
              onClick={handleLogoutClick}
              className="flex items-center justify-center gap-2 w-full px-3 py-2 text-[#f5b1a8] border border-[#f2796b]/40 hover:bg-[#f2796b]/12 rounded-lg text-sm font-medium transition-colors cursor-pointer"
            >
              <LogOut size={16} />
              {t('Sign out')}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0" inert={mobileDrawerOpen}>
        {dueAmount && location.pathname !== '/settings' && (
          <div id="billingBanner" className="bg-purple-100 dark:bg-purple-950/60 text-purple-900 dark:text-purple-200 text-sm px-4 py-1.5 flex items-center justify-between border-b dark:border-purple-800">
            <span>A subscription invoice of <b>₹{Number(dueAmount).toLocaleString('en-IN')}</b> is waiting.</span>
            <Link to="/settings" className="font-semibold underline">Pay now</Link>
          </div>
        )}
        {supportLabel && (
          <div id="supportBanner" className="bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200 text-sm px-4 py-1.5 flex items-center justify-between border-b dark:border-amber-800">
            <span>Support session — you are signed in as <b>{supportLabel}</b>. Every action is recorded.</span>
            <button type="button" id="supportExit" onClick={exitSupport} className="font-semibold underline cursor-pointer">Exit support session</button>
          </div>
        )}
        <header className="min-h-14 shrink-0 bg-white dark:bg-gray-800 border-b dark:border-gray-700 flex flex-wrap items-center justify-between gap-2 px-4 py-2 transition-colors">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              id="navToggle"
              ref={navToggleRef}
              aria-controls="appSidebar"
              aria-expanded={drawerVisible}
              aria-label={drawerVisible ? 'Close navigation menu' : 'Open navigation menu'}
              title={drawerVisible ? 'Close sidebar (Ctrl+B)' : 'Open sidebar (Ctrl+B)'}
              className="p-2 -ml-2 rounded-lg cursor-pointer text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-purple-600 dark:hover:text-purple-400 transition-colors flex items-center justify-center"
              onClick={toggleSidebar}
            >
              <Menu size={20} aria-hidden="true" />
              <span className="ml-2 text-sm">{t('Menu')}</span>
            </button>
            <div className="font-display font-bold text-lg tracking-tight truncate" id="pageTitle">{pageTitle}</div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 text-sm min-w-0 shrink">
            {user.role === 'owner' && saasRole !== 'super_admin' && branches.length > 0 && (
              <label className="flex items-center gap-2 min-w-0">
                <span className="text-gray-500 dark:text-gray-400 text-xs">Branch</span>
                <select
                  id="branchSelect"
                  className="p-1.5 min-w-0 max-w-[6rem] sm:max-w-none border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-xs"
                  value={activeBranchId ?? ''}
                  onChange={(e) => setActiveBranch(e.target.value)}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                  ))}
                </select>
              </label>
            )}

            <LanguageSwitcher />
            {/* Dark / Light Theme Toggle */}
            <button
              id="themeToggle"
              type="button"
              onClick={toggleTheme}
              className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/60 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-medium shrink-0"
              aria-label="Toggle dark/light theme"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? (
                <>
                  <Sun size={16} className="text-amber-400" />
                  <span className="hidden sm:inline">{t('Light')}</span>
                </>
              ) : (
                <>
                  <Moon size={16} className="text-purple-700" />
                  <span className="hidden sm:inline">{t('Dark')}</span>
                </>
              )}
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4">
          {/* Re-mount pages when the owner switches branch so they reload that branch's data */}
          <ErrorBoundary>
            <Outlet key={saasRole === 'super_admin' ? 'platform' : (activeBranchId ?? 'none')} />
          </ErrorBoundary>
        </main>
      </div>

      {(pwOpen || pwForced) && (
        <Modal title={pwForced ? 'Choose a new password' : 'Change password'} onClose={() => { if (!pwForced) setPwOpen(false); }}>
          {pwForced && <div className="p-3 mb-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 text-xs rounded-lg">Your password was set by an administrator. Enter it as the current password, then choose one only you know.</div>}
          <form onSubmit={changePassword} className="space-y-4">
            {pwError && <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-200 text-xs rounded-lg">{pwError}</div>}
            <Field label="Current password">
              <input id="pwCurrent" className="input-base" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <input id="pwNew" className="input-base" type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
            </Field>
            <div className="flex justify-end gap-3">
              {!pwForced && <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => setPwOpen(false)}>Cancel</button>}
              <button id="pwSave" type="submit" className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer">Change password</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Sign-out with unsynced bills warning modal */}
      {showSignoutWarning && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 border dark:border-gray-700">
            <div className="flex justify-between items-start mb-2">
              <h2 className="text-lg font-bold text-red-600 dark:text-red-400" id="modalTitle">
                Sign out with unsynced bills?
              </h2>
              <button
                type="button"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                aria-label="Close"
                onClick={() => setShowSignoutWarning(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div id="modalBody" className="text-sm text-gray-600 dark:text-gray-300 mb-6">
              You have {getPendingQueueCount()} offline bill(s) that have not reached the server yet.
              They stay on this device and are sent only when you sign in here again — other users will not submit them.
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                id="confirmCancel"
                onClick={() => setShowSignoutWarning(false)}
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                id="confirmOk"
                onClick={doLogout}
                className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold hover:bg-red-700"
              >
                Sign out anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
