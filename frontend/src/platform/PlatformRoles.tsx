import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Badge } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  level: string;
  permissions: string[];
  pages: string[] | null;
  isSystem: boolean;
  isActive: boolean;
  userCount: number;
  summary: { granted: number; total: number } | null;
}
interface Catalog {
  groups: { id: string; label: string; permissions: { key: string; label: string; description: string }[] }[];
  pages: { key: string; label: string }[];
  levels: string[];
}
interface Draft { id: string | null; name: string; description: string; level: string; permissions: string[]; ownPages: boolean; pages: string[] }

const LEVEL_LABEL: Record<string, string> = { owner: 'Owner', office_admin: 'Office admin', manager: 'Manager', cashier: 'Cashier', steward: 'Steward' };
const LEVEL_HINT: Record<string, string> = {
  steward: 'Serves tables. Sees the pages and rules of a steward.',
  cashier: 'Bills customers. Sees the pages and rules of a cashier.',
  manager: 'Runs a shop. Sees the pages and rules of a manager, but only the permissions below.',
};
const blank = (): Draft => ({ id: null, name: '', description: '', level: 'cashier', permissions: [], ownPages: false, pages: [] });
const draftOf = (r: Role): Draft => ({ id: r.id, name: r.name, description: r.description ?? '', level: r.level, permissions: [...r.permissions], ownPages: r.pages !== null, pages: r.pages ?? [] });
const same = (a: Draft, b: Draft) => JSON.stringify([a.name, a.description, a.level, [...a.permissions].sort(), a.ownPages, a.ownPages ? [...a.pages].sort() : []]) === JSON.stringify([b.name, b.description, b.level, [...b.permissions].sort(), b.ownPages, b.ownPages ? [...b.pages].sort() : []]);

/** The roles: the five built-in ones (fixed) and the custom ones the Super Admin defines. */
export function PlatformRoles() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);           // a role id, or 'new'
  const [draft, setDraft] = useState<Draft | null>(null);
  const [original, setOriginal] = useState<Draft | null>(null);
  const [touched, setTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (keep?: string) => {
    setError(null);
    try {
      const r = await api.get<{ roles: Role[]; catalog: Catalog }>('/platform/roles');
      setRoles(r.roles);
      setCatalog(r.catalog);
      const pick = keep ?? selected ?? r.roles.find((x) => !x.isSystem)?.id ?? r.roles[0]?.id ?? null;
      if (pick && pick !== 'new') {
        const role = r.roles.find((x) => x.id === pick) ?? r.roles[0];
        if (role) { setSelected(role.id); setDraft(draftOf(role)); setOriginal(draftOf(role)); }
      }
    } catch (e) { setError(errorMessage(e)); }
  }, [selected]);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = roles?.find((r) => r.id === selected) ?? null;
  const editable = selected === 'new' || (!!current && !current.isSystem);
  const readOnly = !editable;
  const dirty = !!draft && !!original && !same(draft, original);

  const open = (id: string) => {
    if (dirty && !window.confirm('Discard the unsaved changes?')) return;
    setSelected(id); setTouched(false); setFormError(null);
    const r = roles?.find((x) => x.id === id);
    if (r) { setDraft(draftOf(r)); setOriginal(draftOf(r)); }
  };
  const startNew = (from?: Role) => {
    if (dirty && !window.confirm('Discard the unsaved changes?')) return;
    const d = from ? { ...draftOf(from), id: null, name: `${from.name} copy`.slice(0, 40), level: ['steward', 'cashier', 'manager'].includes(from.level) ? from.level : 'cashier' } : blank();
    // a duplicate of a built-in manager starts from what a manager can do by default
    if (from?.isSystem && from.key === 'manager') d.permissions = catalog?.groups.flatMap((g) => g.permissions.map((p) => p.key)) ?? [];
    setSelected('new'); setDraft(d); setOriginal(blank()); setTouched(false); setFormError(null);
  };

  const errors = draft ? {
    name: draft.name.trim().length < 3 ? 'Use at least 3 characters' : draft.name.trim().length > 40 ? 'Use at most 40 characters' : '',
    approve: draft.permissions.includes('invoices.approve') && !draft.permissions.includes('cost.view') ? 'Approving supplier invoices also needs “See cost prices”.' : '',
  } : null;

  const toggle = (key: string, on: boolean) => draft && setDraft({ ...draft, permissions: on ? [...new Set([...draft.permissions, key])] : draft.permissions.filter((k) => k !== key) });
  const setGroup = (keys: string[], on: boolean) => draft && setDraft({ ...draft, permissions: on ? [...new Set([...draft.permissions, ...keys])] : draft.permissions.filter((k) => !keys.includes(k)) });

  const save = async () => {
    if (!draft || !errors) return;
    setTouched(true);
    if (errors.name || errors.approve) return;
    setSaving(true); setFormError(null);
    const body = { name: draft.name.trim(), description: draft.description.trim(), level: draft.level, permissions: draft.permissions, pages: draft.ownPages ? draft.pages : null };
    try {
      const saved = draft.id ? await api.patch<Role>(`/platform/roles/${draft.id}`, body) : await api.post<Role>('/platform/roles', body);
      showToast(draft.id ? `${saved.name} saved` : `${saved.name} created`, 'success');
      setSelected(saved.id);
      await load(saved.id);
    } catch (e) { setFormError(errorMessage(e)); } finally { setSaving(false); }
  };

  const setActive = async (r: Role, on: boolean) => {
    try {
      await api.post(`/platform/roles/${r.id}/${on ? 'reactivate' : 'retire'}`);
      showToast(on ? `${r.name} is available again` : `${r.name} retired. People on it keep it.`, 'success');
      await load(r.id);
    } catch (e) { showToast(errorMessage(e), 'error'); }
  };

  const unrestricted = !!current && (current.key === 'owner' || current.key === 'office_admin');
  // what a built-in role has: owner / office admin / manager everything, cashier / steward nothing extra
  const systemHas = (key: string) => !!current && (unrestricted || current.key === 'manager') && !!key;
  const checked = (key: string) => (readOnly ? systemHas(key) : !!draft?.permissions.includes(key));
  const grouped = useMemo(() => catalog?.groups ?? [], [catalog]);

  const input = 'input-base';
  const customRoles = (roles ?? []).filter((r) => !r.isSystem);

  const listItem = (r: Role) => (
    <li key={r.id}>
      <button type="button" data-role={r.key} aria-current={selected === r.id} onClick={() => open(r.id)}
        className={`w-full text-left px-3 py-2 rounded-lg border text-sm cursor-pointer ${selected === r.id ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/30' : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/40'} ${r.isActive ? '' : 'opacity-60'}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold truncate">{r.isSystem && <span aria-hidden title="Built-in">🔒 </span>}{r.name}</span>
          <span className="text-xs text-gray-500 shrink-0">{r.userCount}</span>
        </div>
        <div className="text-[11px] text-gray-500">{LEVEL_LABEL[r.level]}{r.isActive ? '' : ' · retired'}{r.summary ? ` · ${r.summary.granted} of ${r.summary.total} permissions` : ''}</div>
      </button>
    </li>
  );

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto space-y-4" id="page-platform-roles">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="platformRolesTitle">Roles &amp; permissions</h1>
          <p className="text-sm text-gray-500 mt-0.5">A role is a level, a set of permissions and a default menu. Businesses give roles to their staff; only you create them.</p>
        </div>
        <button type="button" id="roleNew" onClick={() => startNew()} className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer">+ New role</button>
      </div>

      {error ? (
        <div id="roleError" className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm flex items-center justify-between gap-3">
          <span>{error}</span><button type="button" onClick={() => void load()} className="px-3 py-1.5 border border-red-300 rounded-lg font-semibold cursor-pointer">Retry</button>
        </div>
      ) : roles === null || catalog === null ? (
        <div id="roleLoading" aria-busy="true" className="grid md:grid-cols-[16rem_1fr] gap-4"><div className="h-64 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" /><div className="h-96 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" /></div>
      ) : (
        <div className="grid md:grid-cols-[16rem_1fr] gap-4 items-start">
          {/* On a phone the list is a picker */}
          <select id="roleSelect" aria-label="Role" className="md:hidden input-base" value={selected ?? ''} onChange={(e) => (e.target.value === 'new' ? startNew() : open(e.target.value))}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isActive ? '' : ' (retired)'}</option>)}
            {selected === 'new' && <option value="new">New role</option>}
          </select>
          <nav className="hidden md:block rounded-xl border bg-white dark:bg-gray-800 dark:border-gray-700 p-2" aria-label="Roles" id="roleList">
            <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">Built-in</div>
            <ul className="space-y-0.5">{roles.filter((r) => r.isSystem).map(listItem)}</ul>
            <div className="px-2 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">Your roles</div>
            {customRoles.length === 0 ? <div className="px-2 py-2 text-xs text-gray-500">None yet. Create one with “New role”.</div> : <ul className="space-y-0.5">{customRoles.map(listItem)}</ul>}
            {selected === 'new' && <div className="mt-1 px-3 py-2 rounded-lg border border-purple-500 bg-purple-50 dark:bg-purple-950/30 text-sm font-semibold">New role (unsaved)</div>}
          </nav>

          {draft && (
            <div className="rounded-xl border bg-white dark:bg-gray-800 dark:border-gray-700 p-4 md:p-5 space-y-5" id="roleEditor" data-editing={selected}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold">{readOnly ? current?.name : draft.id ? draft.name || 'Role' : 'New role'}</h2>
                    {current?.isSystem && <Badge tone="muted">Built-in</Badge>}
                    {current && !current.isSystem && <Badge tone={current.isActive ? 'good' : 'warn'}>{current.isActive ? 'Custom' : 'Retired'}</Badge>}
                  </div>
                  {current && <div className="text-xs text-gray-500">{current.userCount} {current.userCount === 1 ? 'person has' : 'people have'} this role</div>}
                </div>
                <div className="flex gap-2">
                  {current && <button type="button" id="roleDuplicate" onClick={() => startNew(current)} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Duplicate</button>}
                  {current && !current.isSystem && (current.isActive
                    ? <button type="button" id="roleRetire" onClick={() => void setActive(current, false)} className="px-3 py-1.5 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50 cursor-pointer">Retire</button>
                    : <button type="button" id="roleReactivate" onClick={() => void setActive(current, true)} className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 cursor-pointer">Put back</button>)}
                </div>
              </div>

              {readOnly ? (
                <div id="roleLocked" className="p-3 rounded-lg bg-gray-50 dark:bg-gray-900/40 border text-sm text-gray-700 dark:text-gray-200">
                  {unrestricted
                    ? <><b>Cannot be restricted.</b> {current?.name} always has every permission, so nothing here can be switched off.</>
                    : <>{current?.description} Built-in roles cannot be changed; <b>duplicate it</b> to make a version of your own.</>}
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="block text-sm">
                    <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">Name</span>
                    <input id="roleName" className={input} maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Counter lead" />
                    {touched && errors?.name && <span className="text-xs text-red-600">{errors.name}</span>}
                  </label>
                  <label className="block text-sm">
                    <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">Level</span>
                    <select id="roleLevel" className={input} value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })}>
                      {catalog.levels.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                    </select>
                    <span className="text-xs text-gray-500">{LEVEL_HINT[draft.level]}</span>
                  </label>
                  <label className="block text-sm sm:col-span-2">
                    <span className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">Description (optional)</span>
                    <input id="roleDescription" className={input} maxLength={200} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </label>
                </div>
              )}

              <section>
                <h3 className="text-sm font-bold mb-2">Permissions</h3>
                <div className="space-y-2" id="rolePermissions">
                  {grouped.map((g) => (
                    <details key={g.id} open data-group={g.id} className="rounded-lg border dark:border-gray-700">
                      <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer text-sm font-semibold">
                        <span>{g.label}</span>
                        {!readOnly && (
                          <span className="flex gap-2 text-xs font-normal" onClick={(e) => e.preventDefault()}>
                            <button type="button" data-all={g.id} className="text-purple-700 hover:underline cursor-pointer" onClick={() => setGroup(g.permissions.map((p) => p.key), true)}>All</button>
                            <button type="button" data-none={g.id} className="text-purple-700 hover:underline cursor-pointer" onClick={() => setGroup(g.permissions.map((p) => p.key), false)}>None</button>
                          </span>
                        )}
                      </summary>
                      <ul className="divide-y divide-gray-100 dark:divide-gray-700 border-t dark:border-gray-700">
                        {g.permissions.map((p) => (
                          <li key={p.key} className="px-3 py-2">
                            <label className={`flex items-start gap-2 text-sm ${readOnly ? 'cursor-not-allowed' : 'cursor-pointer'}`} title={unrestricted ? 'Owner and office admin cannot be restricted' : readOnly ? 'Built-in roles cannot be changed' : undefined}>
                              <input type="checkbox" data-permission={p.key} className="mt-1" disabled={readOnly} checked={checked(p.key)} onChange={(e) => toggle(p.key, e.target.checked)} />
                              <span><span className="font-medium">{p.label}</span><span className="block text-xs text-gray-500">{p.description}</span></span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
                {!readOnly && errors?.approve && <div id="roleApproveWarn" className="mt-2 text-xs text-amber-700">{errors.approve}</div>}
                {readOnly && !unrestricted && current?.key === 'manager' && <p className="mt-2 text-xs text-gray-500">A person can still have single permissions switched off by their manager or office admin.</p>}
              </section>

              <section>
                <h3 className="text-sm font-bold mb-2">Menu</h3>
                {readOnly ? (
                  <p className="text-sm text-gray-600 dark:text-gray-300">Whatever the level allows.</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-4 text-sm mb-2">
                      <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="roleMenu" id="roleMenuLevel" checked={!draft.ownPages} onChange={() => setDraft({ ...draft, ownPages: false })} />Whatever the level allows</label>
                      <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="roleMenu" id="roleMenuOwn" checked={draft.ownPages} onChange={() => setDraft({ ...draft, ownPages: true })} />Only these pages</label>
                    </div>
                    {draft.ownPages && (
                      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1" id="rolePages">
                        {catalog.pages.map((p) => (
                          <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input type="checkbox" data-page={p.key} checked={draft.pages.includes(p.key)} onChange={(e) => setDraft({ ...draft, pages: e.target.checked ? [...draft.pages, p.key] : draft.pages.filter((k) => k !== p.key) })} />
                            {p.label}
                          </label>
                        ))}
                        <p className="sm:col-span-2 text-xs text-gray-500 mt-1">A page above the role&apos;s level stays closed. A person given their own menu keeps that menu instead.</p>
                      </div>
                    )}
                  </>
                )}
              </section>

              {formError && <div id="roleFormError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{formError}</div>}
              {!readOnly && (
                <div className="flex items-center justify-end gap-3 pt-1 border-t dark:border-gray-700">
                  {dirty && <span className="text-xs text-amber-700 mr-auto">Unsaved changes</span>}
                  <button type="button" id="roleRevert" disabled={!dirty || saving} onClick={() => { if (original && selected !== 'new') setDraft({ ...original }); else if (selected === 'new') setDraft(blank()); setTouched(false); setFormError(null); }} className="px-4 py-2 text-sm border rounded-lg disabled:opacity-40 cursor-pointer">Revert</button>
                  <button type="button" id="roleSave" disabled={saving || (!dirty && selected !== 'new')} onClick={() => void save()} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white rounded-lg cursor-pointer">{draft.id ? 'Save changes' : 'Create role'}</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
