import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { CYCLE_OPTIONS, cycleWord, type PlanInfo } from './planUi';

interface Draft { code: string | null; name: string; price: string; cycleDays: number; maxBranches: string; features: string }
const blank: Draft = { code: null, name: '', price: '', cycleDays: 30, maxBranches: '3', features: '' };

/** The plans on sale: name, price, billing cycle, branch limit, what is included. Plans are retired, never deleted. */
export function PlatformPlans() {
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retiring, setRetiring] = useState<PlanInfo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setPlans((await api.get<{ plans: PlanInfo[] }>('/platform/plans')).plans); } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const edit = (p: PlanInfo) => { setFormError(null); setTouched(false); setDraft({ code: p.code, name: p.name, price: String(Number(p.price)), cycleDays: p.cycleDays, maxBranches: String(p.maxBranches), features: p.features.join('\n') }); };
  const isTrial = draft?.code === 'TRIAL';

  const errors = draft ? {
    name: draft.name.trim().length < 3 ? 'Use at least 3 characters' : draft.name.trim().length > 40 ? 'Use at most 40 characters' : '',
    price: isTrial ? '' : !/^\d{1,6}(\.\d{1,2})?$/.test(draft.price.trim()) ? 'Enter an amount like 2999 or 2999.50' : Number(draft.price) <= 0 ? 'A paid plan needs a price above zero' : '',
    branches: !/^\d+$/.test(draft.maxBranches) || Number(draft.maxBranches) < 1 || Number(draft.maxBranches) > 500 ? 'Enter a number from 1 to 500' : '',
    features: draft.features.split('\n').map((f) => f.trim()).filter(Boolean).length > 12 ? 'At most 12 features' : '',
  } : null;
  const invalid = !!errors && Object.values(errors).some(Boolean);

  const save = async () => {
    if (!draft) return;
    setTouched(true);
    if (invalid) return;
    setSaving(true);
    setFormError(null);
    const features = draft.features.split('\n').map((f) => f.trim()).filter(Boolean);
    const body = { name: draft.name.trim(), maxBranches: Number(draft.maxBranches), features, ...(isTrial ? {} : { price: draft.price.trim(), cycleDays: draft.cycleDays }) };
    try {
      if (draft.code) await api.patch(`/platform/plans/${draft.code}`, body);
      else await api.post('/platform/plans', body);
      showToast(draft.code ? `${draft.name.trim()} updated` : `${draft.name.trim()} created`, 'success');
      setDraft(null);
      await load();
    } catch (err) { setFormError(errorMessage(err)); } finally { setSaving(false); }
  };

  const setActive = async (p: PlanInfo, on: boolean) => {
    try {
      await api.post(`/platform/plans/${p.code}/${on ? 'reactivate' : 'retire'}`);
      showToast(on ? `${p.name} is on sale again` : `${p.name} retired`, 'success');
      setRetiring(null);
      await load();
    } catch (err) { showToast(errorMessage(err), 'error'); }
  };

  const input = 'input-base';
  const err = (m: string | undefined) => (touched && m ? <div className="text-xs text-red-600 mt-0.5">{m}</div> : null);

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto space-y-4" id="page-platform-plans">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="platformPlansTitle">Plans &amp; billing</h1>
          <p className="text-sm text-gray-500 mt-0.5">The plans you sell to businesses. To move one business to a plan, use <b>Change plan</b> on the Platform Console.</p>
        </div>
        <button type="button" id="planAdd" onClick={() => { setFormError(null); setTouched(false); setDraft({ ...blank }); }} className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer">+ New plan</button>
      </div>

      {error ? (
        <div id="planError" className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm flex items-center justify-between gap-3">
          <span>{error}</span><button type="button" onClick={() => void load()} className="px-3 py-1.5 border border-red-300 rounded-lg font-semibold cursor-pointer">Retry</button>
        </div>
      ) : plans === null ? (
        <div id="planLoading" aria-busy="true" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{[0, 1, 2].map((i) => <div key={i} className="h-44 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />)}</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3" id="planGrid">
          {plans.map((p) => (
            <div key={p.code} data-plan={p.code} className={`rounded-xl border p-4 bg-white dark:bg-gray-800 dark:border-gray-700 flex flex-col ${p.isActive ? '' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-bold text-lg">{p.name}</div>
                  <div className="text-[11px] font-mono text-gray-400">{p.code}</div>
                </div>
                <Badge tone={p.isActive ? 'good' : 'muted'}>{p.isActive ? 'On sale' : 'Retired'}</Badge>
              </div>
              <div className="mt-2 text-2xl font-mono font-semibold">
                {Number(p.price) === 0 ? 'Free' : inr(p.price)}{Number(p.price) > 0 && <span className="text-sm font-normal text-gray-500"> / {cycleWord(p.cycleDays)}</span>}
              </div>
              <div className="text-xs text-gray-500 mt-1">Up to {p.maxBranches} branch{p.maxBranches === 1 ? '' : 'es'} · {p.tenantCount} business{p.tenantCount === 1 ? '' : 'es'} on it</div>
              <ul className="mt-3 text-sm space-y-1 flex-1">
                {p.features.length === 0 ? <li className="text-gray-400 text-xs">No features listed</li> : p.features.map((f) => <li key={f} className="flex gap-2"><span className="text-emerald-600">✓</span>{f}</li>)}
              </ul>
              <div className="mt-4 flex gap-2">
                <button type="button" data-action="edit" onClick={() => edit(p)} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">Edit</button>
                {p.code !== 'TRIAL' && (p.isActive
                  ? <button type="button" data-action="retire" onClick={() => setRetiring(p)} className="px-3 py-1.5 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50 cursor-pointer">Retire</button>
                  : <button type="button" data-action="reactivate" onClick={() => void setActive(p, true)} className="px-3 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 cursor-pointer">Put back on sale</button>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && errors && (
        <Modal title={draft.code ? `Edit ${draft.name || 'plan'}` : 'New plan'} onClose={() => setDraft(null)}>
          <div className="space-y-3" id="planForm">
            <Field label="Name">
              <input id="planName" className={input} value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Gold" />
              {err(errors.name)}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Price (GST included)" hint={isTrial ? 'The trial is always free.' : undefined}>
                <input id="planPrice" className={`${input} font-mono`} inputMode="decimal" disabled={isTrial} value={isTrial ? '0' : draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="2999" />
                {err(errors.price)}
              </Field>
              <Field label="Billed">
                <select id="planCycle" className={input} disabled={isTrial} value={draft.cycleDays} onChange={(e) => setDraft({ ...draft, cycleDays: Number(e.target.value) })}>
                  {CYCLE_OPTIONS.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Branch limit">
              <input id="planBranches" className={`${input} font-mono`} inputMode="numeric" value={draft.maxBranches} onChange={(e) => setDraft({ ...draft, maxBranches: e.target.value })} />
              {err(errors.branches)}
            </Field>
            <Field label="What it includes (one per line)">
              <textarea id="planFeatures" className={`${input} min-h-[5.5rem]`} value={draft.features} onChange={(e) => setDraft({ ...draft, features: e.target.value })} placeholder={'Up to 5 branches\nBank reconciliation'} />
              {err(errors.features)}
            </Field>
            {draft.code && !isTrial && <p className="text-xs text-gray-500">A new price or limit applies to invoices raised from now on and to businesses that move to this plan. Invoices already raised, and limits already set on a business, do not change.</p>}
            {formError && <div id="planFormError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{formError}</div>}
            <div className="flex justify-end gap-3 pt-1">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" id="planSave" disabled={saving} onClick={() => void save()} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">{draft.code ? 'Save' : 'Create plan'}</button>
            </div>
          </div>
        </Modal>
      )}

      {retiring && (
        <Modal title={`Retire ${retiring.name}?`} onClose={() => setRetiring(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {retiring.name} can no longer be chosen for new businesses or plan changes.
            {retiring.tenantCount > 0 ? ` The ${retiring.tenantCount} business${retiring.tenantCount === 1 ? '' : 'es'} already on it keep it and keep being billed its price.` : ' No business is on it.'}
            {' '}You can put it back on sale at any time.
          </p>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setRetiring(null)}>Cancel</button>
            <button type="button" id="planRetireOk" className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg cursor-pointer" onClick={() => void setActive(retiring, false)}>Retire</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
