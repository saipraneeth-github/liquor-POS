import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { CashierView } from './CashierView';
import { ManagerView } from './ManagerView';
import { OwnerView } from './OwnerView';
import { OfficeAdminView } from './OfficeAdminView';
import { Icon } from './parts';
import type { AttentionItem, CashierData, ManagerData, OwnerData } from './types';

type Scope = 'all' | 'branch';
type Loaded = { kind: 'cashier'; data: CashierData } | { kind: 'manager'; data: ManagerData } | { kind: 'owner'; data: OwnerData };

const REFRESH_MS = 60_000;

function Skeleton() {
  return (
    <div id="dashLoading" aria-busy="true" aria-label="Loading today's figures" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="lc-skel" style={{ height: 38, width: '60%' }} />
      <div className="lc-grid lc-g-kpi">{[0, 1, 2, 3].map((i) => <div key={i} className="lc-skel" style={{ height: 118 }} />)}</div>
      <div className="lc-grid lc-g-2"><div className="lc-skel" style={{ height: 300 }} /><div className="lc-skel" style={{ height: 300 }} /></div>
    </div>
  );
}

export function Dashboard() {
  const { user, activeBranchId, branches, setActiveBranch } = useAuth();
  const navigate = useNavigate();
  const branchId = activeBranchId ?? user?.branchId ?? '';
  const isSteward = user?.role === 'steward';
  const isOfficeAdmin = user?.role === 'office_admin';
  const canSeeAllOutlets = user?.role === 'owner' && !!user?.syndicateId;

  const [scope, setScope] = useState<Scope>(canSeeAllOutlets ? 'all' : 'branch');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const inflight = useRef(0);

  const load = useCallback(async () => {
    if (isSteward || isOfficeAdmin || (!branchId && scope === 'branch')) return;
    const ticket = ++inflight.current;
    try {
      let next: Loaded;
      if (scope === 'all') next = { kind: 'owner', data: await api.get<OwnerData>('/dashboard/owner') };
      else if (user?.role === 'cashier') next = { kind: 'cashier', data: await api.get<CashierData>(`/dashboard/branch/${branchId}`) };
      else next = { kind: 'manager', data: await api.get<ManagerData>(`/dashboard/branch/${branchId}`) };
      if (ticket !== inflight.current) return;          // a newer request is already on its way
      setLoaded(next);
      setError('');
      setUpdatedAt(new Date());
    } catch (err) {
      if (ticket !== inflight.current) return;
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
  }, [branchId, isSteward, scope, user?.role]);

  useEffect(() => { void load(); }, [load]);

  // Keep it fresh without the user pressing anything: every minute, when the tab comes back, and after a sale or a stock change
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('app:stock_updated', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); window.removeEventListener('app:stock_updated', tick); };
  }, [load]);

  useEffect(() => {
    if (isSteward) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' && !e.repeat) { e.preventDefault(); navigate('/pos'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSteward, navigate]);

  const go = (route: string) => navigate(route);
  const goAttention = (a: AttentionItem) => {
    if (a.branchId && a.branchId !== branchId) setActiveBranch(a.branchId);   // an owner jumps into that outlet's screen
    navigate(a.route);
  };
  const openBranch = (id: string) => { setActiveBranch(id); setScope('branch'); setLoaded(null); };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (user?.name ?? '').split(' ')[0] || 'there';
  const dateText = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (isSteward) {
    return (
      <section className="page active lc lc-bleed" id="page-dashboard" aria-labelledby="dashTitle">
        <div className="lc-page">
          <div className="lc-greet"><div><h2 id="dashTitle">{greeting}, {firstName}</h2><p>{dateText}</p></div></div>
          <div className="lc-card" style={{ maxWidth: 560 }}>
            <h3>Steward access</h3>
            <p style={{ margin: '0 0 14px', color: 'var(--muted)' }}>
              Use <b style={{ color: 'var(--text)' }}>Tables &amp; KOT</b> to see occupied tables, raise KOTs and update item status. Opening tables, billing, inventory and reports need a cashier or manager login.
            </p>
            <button type="button" className="lc-btn lc-btn-primary" id="dashTablesBtn" onClick={() => go('/tables')}>Open Tables &amp; KOT</button>
          </div>
        </div>
      </section>
    );
  }

  if (isOfficeAdmin) {
    const currentBranch = branches.find((b) => b.id === (branchId || user?.branchId));
    const shopName = currentBranch?.name || 'Main Counter Branch';
    return (
      <section className="page active lc lc-bleed" id="page-dashboard" aria-labelledby="officeAdminWelcome">
        <div className="lc-page">
          <OfficeAdminView shopName={shopName} onNavigate={go} />
        </div>
      </section>
    );
  }

  const subtitle = scope === 'all' ? `${dateText} · every outlet` : dateText;
  return (
    <section className="page active lc lc-bleed" id="page-dashboard" aria-labelledby="dashTitle">
      <div className="lc-page">
        <div className="lc-greet">
          <div>
            <h2 id="dashTitle">{scope === 'all' ? 'All outlets today' : `${greeting}, ${firstName}`}</h2>
            <p id="dashSub">{subtitle}{updatedAt && <span className="lc-updated"> · updated {updatedAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).toUpperCase()}</span>}</p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {canSeeAllOutlets && (
              <div role="group" aria-label="View" style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface)' }}>
                {([['all', 'All outlets'], ['branch', 'This outlet']] as const).map(([s, label]) => (
                  <button key={s} type="button" id={`dashScope-${s}`} aria-pressed={scope === s} onClick={() => { setScope(s); setLoaded(null); }}
                    style={{ border: 0, padding: '8px 14px', fontWeight: 600, background: scope === s ? 'var(--surface-2)' : 'transparent', color: scope === s ? 'var(--text)' : 'var(--muted)', boxShadow: scope === s ? 'inset 0 0 0 1px var(--line)' : 'none' }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {scope === 'branch' && (
              <button className="lc-btn lc-btn-primary lc-btn-big" type="button" id="dashNewBill" onClick={() => go('/pos')}>
                {Icon.plus} New bill <kbd className="lc-kbd">F2</kbd>
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="lc-error" id="dashError" role="alert">
            <span>{error}{loaded ? ' Showing the last figures we had.' : ''}</span>
            <button type="button" className="lc-btn lc-btn-ghost" onClick={() => void load()}>Try again</button>
          </div>
        )}

        {!loaded && !error && <Skeleton />}
        {loaded?.kind === 'cashier' && <CashierView data={loaded.data} firstName={firstName} onGo={go} onAttention={goAttention} />}
        {loaded?.kind === 'manager' && <ManagerView data={loaded.data} onGo={go} onAttention={goAttention} />}
        {loaded?.kind === 'owner' && <OwnerView data={loaded.data} onAttention={goAttention} onOpenBranch={openBranch} />}
      </div>
    </section>
  );
}
