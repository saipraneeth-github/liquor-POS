import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { api } from '../api/client';

export type User = {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'manager' | 'cashier' | 'steward';
  branchId?: string | null;
  syndicateId?: string | null;
  /** OK, or why the business is locked: TRIAL_EXPIRED / OVERDUE (SUSPENDED never gets this far). */
  access?: 'OK' | 'TRIAL_EXPIRED' | 'OVERDUE' | 'SUSPENDED';
};

export type BranchOption = { id: string; name: string; code: string };

/** Owners have no home branch; they work in the branch picked in the header. */
export type SaasRole = 'super_admin' | 'admin' | 'manager' | 'cashier' | 'steward';

interface AuthContextType {
  /** `branchId` is the branch the app is working in (an owner's selected branch). */
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  error: string | null;
  /** True while a stored session is being checked, so a page reload does not bounce to the login screen. */
  loading: boolean;
  saasRole: SaasRole | null;
  branches: BranchOption[];
  activeBranchId: string | null;
  setActiveBranch: (id: string) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);
const ACTIVE_BRANCH_KEY = 'activeBranchId';

export function saasRoleOf(u: User | null): SaasRole | null {
  if (!u) return null;
  if (u.role === 'owner') return u.syndicateId ? 'admin' : 'super_admin';
  return u.role;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [rawUser, setRawUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !!localStorage.getItem('token'));
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(ACTIVE_BRANCH_KEY));

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem(ACTIVE_BRANCH_KEY);
    setRawUser(null);
    setBranches([]);
    setSelected(null);
  };

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    // Validate the stored token against /me — expired or invalid tokens will 401
    api.get<User>('/me')
      .then((freshUser) => {
        setRawUser(freshUser);
        localStorage.setItem('user', JSON.stringify(freshUser));
      })
      .catch(() => {
        setError('Your session has expired. Please sign in again.');
        logout();
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Owners pick a branch to work in; load the ones they may access
  const isOwner = rawUser?.role === 'owner';
  useEffect(() => {
    if (!isOwner) return;
    api.get<BranchOption[]>('/branches')
      .then((list) => {
        setBranches(list);
        setSelected((cur) => (cur && list.some((b) => b.id === cur) ? cur : list[0]?.id ?? null));
      })
      .catch(() => setBranches([]));
  }, [isOwner, rawUser?.id]);

  const login = (token: string, next: User) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(next));
    setRawUser(next);
    setError(null);
  };

  const setActiveBranch = (id: string) => {
    localStorage.setItem(ACTIVE_BRANCH_KEY, id);
    setSelected(id);
  };

  const user = useMemo<User | null>(() => {
    if (!rawUser) return null;
    return rawUser.role === 'owner' ? { ...rawUser, branchId: selected } : rawUser;
  }, [rawUser, selected]);

  return (
    <AuthContext.Provider
      value={{ user, login, logout, error, loading, saasRole: saasRoleOf(rawUser), branches, activeBranchId: selected, setActiveBranch }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
