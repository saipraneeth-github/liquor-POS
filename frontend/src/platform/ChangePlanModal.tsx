import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Field, Modal, inr } from '../components/ui';
import { errorMessage, showToast } from '../lib/print';
import { businessDay, cycleWord, fmtDay, type PlanInfo, type PlanPreview } from './planUi';

interface TenantLite { id: string; name: string; plan: string; nextPlan: string | null; nextPlanFrom: string | null }

/**
 * Put a business on another plan, now or on a later day. The cost is shown before anything is confirmed:
 * unused time on the current plan is credited against the new price.
 */
export function ChangePlanModal({ tenant, plans, onClose, onDone }: { tenant: TenantLite; plans: PlanInfo[]; onClose: () => void; onDone: () => void }) {
  const choices = plans.filter((p) => p.isActive && p.code !== 'TRIAL');
  const [plan, setPlan] = useState(choices.find((p) => p.code !== tenant.plan)?.code ?? '');
  const [effective, setEffective] = useState(businessDay());
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = businessDay();

  useEffect(() => {
    if (!plan) return;
    let live = true;
    setPreview(null);
    setError(null);
    api.get<PlanPreview>(`/platform/tenants/${tenant.id}/plan-preview?plan=${encodeURIComponent(plan)}&effective=${effective}`)
      .then((p) => { if (live) setPreview(p); })
      .catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [tenant.id, plan, effective]);

  const later = effective > today;
  const canConfirm = !!preview && preview.fitsBranches && !preview.sameAsCurrent && !busy;

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ scheduled: boolean }>(`/platform/tenants/${tenant.id}/plan`, { plan, effectiveDate: effective });
      showToast(r.scheduled ? `Change to ${preview?.target.name} scheduled for ${fmtDay(effective)}` : `${tenant.name} is now on ${preview?.target.name}`, 'success');
      onDone();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  const cancelScheduled = async () => {
    setBusy(true);
    try { await api.delete(`/platform/tenants/${tenant.id}/plan/scheduled`); showToast('Scheduled change cancelled', 'success'); onDone(); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };

  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between gap-4 py-1 ${strong ? 'font-bold border-t dark:border-gray-600 mt-1 pt-2' : ''}`}><span className="text-gray-600 dark:text-gray-300">{label}</span><span className="font-mono">{value}</span></div>
  );

  return (
    <Modal title={`Change plan — ${tenant.name}`} onClose={onClose}>
      <div className="space-y-4" id="changePlanForm">
        {tenant.nextPlan && (
          <div id="scheduledNote" className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 text-sm flex flex-wrap items-center justify-between gap-2">
            <span>Already scheduled: <b>{plans.find((p) => p.code === tenant.nextPlan)?.name ?? tenant.nextPlan}</b> from {fmtDay(tenant.nextPlanFrom)}. Confirming a new change replaces it.</span>
            <button type="button" id="cpCancelScheduled" disabled={busy} onClick={() => void cancelScheduled()} className="px-3 py-1 text-xs border border-blue-300 rounded-lg font-semibold cursor-pointer">Cancel it</button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="New plan">
            <select id="cpPlan" className="input-base" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {choices.map((p) => <option key={p.code} value={p.code} disabled={p.code === tenant.plan}>{p.name}{p.code === tenant.plan ? ' (current)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Effective from" hint="Today, or up to 90 days ahead.">
            <input id="cpDate" type="date" className="input-base" min={today} max={businessDay(90)} value={effective} onChange={(e) => setEffective(e.target.value || today)} />
          </Field>
        </div>

        {error && <div id="cpError" className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>}
        {!error && !preview && plan && <div id="cpLoading" className="h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" aria-busy="true" />}
        {!plan && <div className="text-sm text-gray-500">There is no other paid plan on sale to move to.</div>}

        {preview && (
          <div id="cpPreview" className="p-3 rounded-lg border dark:border-gray-700 text-sm">
            {row(`${preview.current.name} (current)`, `${inr(preview.current.price)} / ${cycleWord(preview.current.cycleDays)}`)}
            {row(`Unused time on it${preview.currentPaid ? '' : ' (not paid for, so no credit)'}`, preview.currentPaid ? `${preview.unusedDays} days` : '—')}
            {row('Credit', `− ${inr(preview.credit)}`)}
            {row(`${preview.target.name} price`, `${inr(preview.newPrice)} / ${cycleWord(preview.target.cycleDays)}`)}
            {row(later ? 'Due when it starts' : 'Due now', inr(preview.amountDue), true)}
            <div className="text-xs text-gray-500 mt-2">New period {fmtDay(preview.periodStart)} – {fmtDay(preview.periodEnd)} · branch limit {preview.target.maxBranches} ({preview.branchesInUse} in use)</div>
            {preview.warnings.map((w) => <div key={w} className="text-xs text-amber-700 mt-1">{w}</div>)}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={onClose}>Cancel</button>
          <button type="button" id="cpConfirm" disabled={!canConfirm} onClick={() => void confirm()} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
            {later ? `Schedule for ${fmtDay(effective)}` : 'Change plan now'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
