import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { Badge, Field, Modal, Stat, inr } from '../components/ui';

type Plan = 'TRIAL' | 'STANDARD' | 'PRO';

interface Tenant {
  id: string;
  name: string;
  gstin: string | null;
  plan: Plan;
  maxBranches: number;
  isActive: boolean;
  branchCount: number;
  staffCount: number;
  bills30d: number;
  sales30d: string;
  lastBillAt: string | null;
  admins: { id: string; name: string; email: string; isActive: boolean }[];
  access: 'OK' | 'SUSPENDED' | 'TRIAL_EXPIRED' | 'OVERDUE';
  trialEndsAt: string | null;
  paidUntil: string | null;
}

interface Invoice {
  id: string;
  plan: string;
  amount: string;
  periodStart: string;
  periodEnd: string;
  status: 'PENDING' | 'PAID' | 'VOID';
  paidAt: string | null;
  paymentRef: string | null;
}

interface Integration { key: string; name: string; mode: 'live' | 'test'; ready: boolean; summary: string; missing: string[] }
interface OutboxMail { id: string; toEmail: string; subject: string; status: 'SENT' | 'LOGGED' | 'FAILED'; kind: string | null; createdAt: string; body: string }

interface AuditEvent {
  id: string;
  action: string;
  actor: string | null;
  createdAt: string;
  meta: Record<string, unknown> | null;
}

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** One line describing where the tenant stands on payment. */
function billingLine(t: Tenant): string {
  if (t.plan === 'TRIAL') return t.trialEndsAt ? `Trial ends ${fmtDate(t.trialEndsAt)}` : 'Trial';
  return t.paidUntil ? `Paid to ${fmtDate(t.paidUntil)}` : 'Manually managed';
}

interface Overview {
  tenants: number;
  activeTenants: number;
  suspendedTenants: number;
  trialTenants: number;
  branches: number;
  staff: number;
  bills30d: number;
  sales30d: string;
}

const PLAN_TONE = { TRIAL: 'warn', STANDARD: 'info', PRO: 'good' } as const;
const PLAN_DEFAULT_LIMIT: Record<Plan, number> = { TRIAL: 1, STANDARD: 3, PRO: 25 };

const blankForm = {
  name: '', gstin: '', plan: 'TRIAL' as Plan, maxBranches: '', adminName: '', adminEmail: '', adminPassword: '',
};

/** Super Admin console: every bar business (tenant) on the platform. */
export function Platform() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<typeof blankForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ tenant: Tenant; plan: Plan; maxBranches: string; accessUntil: string } | null>(null);
  const [suspending, setSuspending] = useState<Tenant | null>(null);
  const [billing, setBilling] = useState<{ tenant: Tenant; invoices: Invoice[] } | null>(null);
  const [payRef, setPayRef] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<{ email: string; password: string } | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [outbox, setOutbox] = useState<OutboxMail[]>([]);
  const [mailOpen, setMailOpen] = useState<OutboxMail | null>(null);
  const [runningJob, setRunningJob] = useState(false);

  const loadIntegrations = useCallback(() => {
    api.get<{ integrations: Integration[] }>('/platform/integrations').then((r) => setIntegrations(r.integrations)).catch(() => setIntegrations([]));
    api.get<{ emails: OutboxMail[] }>('/platform/outbox').then((r) => setOutbox(r.emails)).catch(() => setOutbox([]));
  }, []);

  const runBillingJob = async () => {
    setRunningJob(true);
    try {
      const r = await api.post<{ tenants: number; invoicesCreated: number; emailsSent: number }>('/platform/billing/run');
      showToast(`Billing job done: ${r.invoicesCreated} invoice(s) raised, ${r.emailsSent} reminder(s) sent.`);
      loadIntegrations();
      load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setRunningJob(false);
    }
  };

  const loadAudit = useCallback(() => {
    api.get<{ events: AuditEvent[] }>('/platform/audit').then((r) => setAudit(r.events)).catch(() => setAudit([]));
  }, []);

  const openBilling = async (tenant: Tenant) => {
    try {
      const res = await api.get<{ invoices: Invoice[] }>(`/platform/tenants/${tenant.id}/invoices`);
      setBilling({ tenant, invoices: res.invoices });
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const generateInvoice = async () => {
    if (!billing) return;
    try {
      await api.post(`/platform/tenants/${billing.tenant.id}/invoices`);
      showToast('Invoice generated.');
      await openBilling(billing.tenant);
    } catch (err) {
      showToast(friendly(errorMessage(err)), 'error');
    }
  };

  const markPaid = async (inv: Invoice) => {
    if (!billing) return;
    try {
      await api.post(`/platform/invoices/${inv.id}/pay`, { paymentRef: (payRef[inv.id] ?? '').trim() });
      showToast('Payment recorded. Access extended.');
      await load();
      const fresh = await api.get<{ invoices: Invoice[] }>(`/platform/tenants/${billing.tenant.id}/invoices`);
      setBilling({ tenant: billing.tenant, invoices: fresh.invoices });
      loadAudit();
    } catch (err) {
      showToast(friendly(errorMessage(err)), 'error');
    }
  };

  const resetAdminPassword = async (tenant: Tenant) => {
    const admin = tenant.admins.find((a) => a.isActive) ?? tenant.admins[0];
    if (!admin) return showToast('This tenant has no admin.', 'error');
    try {
      const res = await api.post<{ email: string; temporaryPassword: string }>(`/platform/tenants/${tenant.id}/admins/${admin.id}/reset-password`);
      setReveal({ email: res.email, password: res.temporaryPassword });
      loadAudit();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  /** Support sign-in: swap to a 30 minute token for the tenant's Admin; the banner in the app offers the way back. */
  const supportSignIn = async (tenant: Tenant) => {
    try {
      const res = await api.post<{ token: string; as: { name: string; email: string } }>(`/platform/tenants/${tenant.id}/impersonate`);
      localStorage.setItem('support_return_token', localStorage.getItem('token') ?? '');
      localStorage.setItem('support_label', `${tenant.name} (${res.as.email})`);
      localStorage.setItem('token', res.token);
      localStorage.removeItem('activeBranchId');
      window.location.assign('/settings');
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, t] = await Promise.all([
        api.get<Overview>('/platform/overview'),
        api.get<{ tenants: Tenant[] }>('/platform/tenants'),
      ]);
      setOverview(o);
      setTenants(t.tenants);
      loadAudit();
      loadIntegrations();
    } catch (err) {
      showToast('Could not load platform data: ' + errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [loadAudit, loadIntegrations]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = tenants.filter((t) => !search.trim() || t.name.toLowerCase().includes(search.trim().toLowerCase()));

  const createTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/platform/tenants', {
        name: form.name.trim(),
        ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}),
        plan: form.plan,
        ...(form.maxBranches ? { maxBranches: Number(form.maxBranches) } : {}),
        admin: { name: form.adminName.trim(), email: form.adminEmail.trim(), password: form.adminPassword },
      });
      showToast(`Tenant "${form.name.trim()}" created. Share the Admin's sign-in details with them.`);
      setForm(null);
      load();
    } catch (err) {
      setFormError(friendly(errorMessage(err)));
    } finally {
      setSaving(false);
    }
  };

  const savePlan = async () => {
    if (!editing) return;
    try {
      // "Access until" extends the trial (TRIAL plan) or the paid period (paid plans) to the end of that day
      const until = editing.accessUntil ? new Date(`${editing.accessUntil}T23:59:59`).toISOString() : undefined;
      await api.patch(`/platform/tenants/${editing.tenant.id}`, {
        plan: editing.plan,
        maxBranches: Number(editing.maxBranches),
        ...(until ? (editing.plan === 'TRIAL' ? { trialEndsAt: until } : { paidUntil: until }) : {}),
      });
      showToast('Plan updated.');
      setEditing(null);
      load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const setActive = async (tenant: Tenant, isActive: boolean) => {
    try {
      await api.patch(`/platform/tenants/${tenant.id}`, { isActive });
      showToast(isActive ? `${tenant.name} reactivated.` : `${tenant.name} suspended. Nobody there can sign in.`);
      setSuspending(null);
      load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  return (
    <section className="max-w-7xl mx-auto space-y-5" id="page-platform">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Platform Console</h1>
          <p className="text-sm text-gray-500 mt-1">Every bar business on the platform — plans, branch limits, usage and access.</p>
        </div>
        <button
          type="button"
          id="tenantAddBtn"
          onClick={() => { setFormError(null); setForm({ ...blankForm }); }}
          className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer"
        >
          + Add tenant
        </button>
      </div>

      {overview && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" id="platformStats">
          <Stat label="Tenants" value={overview.tenants} />
          <Stat label="Active / suspended" value={`${overview.activeTenants} / ${overview.suspendedTenants}`} tone={overview.suspendedTenants ? 'warn' : undefined} />
          <Stat label="Branches" value={overview.branches} />
          <Stat label="Staff accounts" value={overview.staff} />
          <Stat label="On trial" value={overview.trialTenants} tone={overview.trialTenants ? 'warn' : undefined} />
          <Stat label="Bills (30 days)" value={overview.bills30d.toLocaleString('en-IN')} />
          <Stat label="Sales (30 days)" value={inr(overview.sales30d)} tone="good" />
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 space-y-3" id="integrationsCard">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Integrations</h2>
          <button type="button" id="runBillingBtn" disabled={runningJob} onClick={runBillingJob} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 cursor-pointer">
            {runningJob ? 'Running…' : 'Run billing job now'}
          </button>
        </div>
        <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
          {integrations.map((i) => (
            <li key={i.key} className="py-2 flex flex-wrap items-start justify-between gap-2 integration-row" data-integration={i.key}>
              <span>
                <b>{i.name}</b> <Badge tone={i.ready ? 'good' : i.mode === 'live' ? 'warn' : 'muted'}>{i.ready ? 'Live' : i.mode === 'live' ? 'Partly set up' : 'Test mode'}</Badge>
                <span className="block text-xs text-gray-500">{i.summary}</span>
              </span>
              {i.missing.length > 0 && <span className="text-xs font-mono text-amber-700">to add in .env: {i.missing.join(', ')}</span>}
            </li>
          ))}
        </ul>
        <div>
          <div className="text-xs font-semibold text-gray-500 mb-1">Recent e-mails {outbox.some((m) => m.status === 'LOGGED') && <span className="font-normal">(LOGGED = stored only, no SMTP server yet)</span>}</div>
          {outbox.length === 0 ? (
            <div className="text-xs text-gray-500">None yet.</div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-xs" id="outboxList">
              {outbox.slice(0, 6).map((m) => (
                <li key={m.id} className="py-1.5 flex justify-between gap-3 outbox-row">
                  <button type="button" className="text-left hover:underline cursor-pointer" onClick={() => setMailOpen(m)}>{m.subject} <span className="text-gray-500">→ {m.toEmail}</span></button>
                  <Badge tone={m.status === 'SENT' ? 'good' : m.status === 'FAILED' ? 'bad' : 'muted'}>{m.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {mailOpen && (
        <Modal title={mailOpen.subject} onClose={() => setMailOpen(null)}>
          <div className="text-xs text-gray-500 mb-2">To {mailOpen.toEmail} · {mailOpen.status}</div>
          <pre className="whitespace-pre-wrap text-sm bg-gray-50 dark:bg-gray-900/40 border rounded-lg p-3" id="mailBody">{mailOpen.body}</pre>
        </Modal>
      )}

      <input
        className="w-full max-w-sm p-2 border rounded-lg text-sm dark:bg-gray-800 dark:border-gray-600"
        placeholder="Search tenants…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading tenants…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No tenants yet.</div>
        ) : (
          <table className="w-full text-left text-sm" id="tenantTable">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                <th className="py-2.5 px-4">Business</th>
                <th className="py-2.5 px-4">Plan</th>
                <th className="py-2.5 px-4">Branches</th>
                <th className="py-2.5 px-4">Staff</th>
                <th className="py-2.5 px-4 text-right">30-day sales</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {visible.map((t) => (
                <tr key={t.id} className="tenant-row" data-tenant-name={t.name}>
                  <td className="py-3 px-4">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-gray-500">{t.admins.map((a) => a.email).join(', ') || 'No admin'}</div>
                  </td>
                  <td className="py-3 px-4">
                    <Badge tone={PLAN_TONE[t.plan]}>{t.plan}</Badge>
                    <div className="text-[11px] text-gray-500 mt-1">{billingLine(t)}</div>
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <span className={t.branchCount >= t.maxBranches ? 'text-amber-600 font-semibold' : ''}>{t.branchCount}</span> / {t.maxBranches}
                  </td>
                  <td className="py-3 px-4 font-mono">{t.staffCount}</td>
                  <td className="py-3 px-4 text-right">
                    <div className="font-mono font-semibold">{inr(t.sales30d)}</div>
                    <div className="text-xs text-gray-500">{t.bills30d} bills</div>
                  </td>
                  <td className="py-3 px-4">
                    {!t.isActive ? <Badge tone="bad">Suspended</Badge>
                      : t.access === 'TRIAL_EXPIRED' ? <Badge tone="bad">Trial ended</Badge>
                      : t.access === 'OVERDUE' ? <Badge tone="bad">Payment overdue</Badge>
                      : <Badge tone="good">Active</Badge>}
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button type="button" className="text-xs text-purple-600 hover:underline mr-3 cursor-pointer" onClick={() => setEditing({ tenant: t, plan: t.plan, maxBranches: String(t.maxBranches), accessUntil: '' })}>Plan &amp; limits</button>
                    <button type="button" className="tenant-billing text-xs text-purple-600 hover:underline mr-3 cursor-pointer" onClick={() => openBilling(t)}>Billing</button>
                    <button type="button" className="text-xs text-gray-600 dark:text-gray-300 hover:underline mr-3 cursor-pointer" onClick={() => resetAdminPassword(t)}>Reset password</button>
                    <button type="button" className="tenant-support text-xs text-gray-600 dark:text-gray-300 hover:underline mr-3 cursor-pointer" onClick={() => supportSignIn(t)}>Support sign-in</button>
                    {t.isActive ? (
                      <button type="button" className="text-xs text-red-600 hover:underline cursor-pointer" onClick={() => setSuspending(t)}>Suspend</button>
                    ) : (
                      <button type="button" className="text-xs text-emerald-600 hover:underline cursor-pointer" onClick={() => setActive(t, true)}>Reactivate</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4" id="auditCard">
        <h2 className="text-sm font-semibold mb-2">Recent activity</h2>
        {audit.length === 0 ? (
          <div className="text-sm text-gray-500">Nothing recorded yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
            {audit.slice(0, 10).map((e) => (
              <li key={e.id} className="py-1.5 flex justify-between gap-3">
                <span><b className="font-mono text-xs">{e.action}</b> <span className="text-gray-500">by {e.actor ?? 'system'}</span></span>
                <span className="text-xs text-gray-500">{new Date(e.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {billing && (
        <Modal title={`Billing — ${billing.tenant.name}`} onClose={() => setBilling(null)} wide>
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span>{billing.tenant.plan} plan · {billingLine(billing.tenant)}</span>
              <button type="button" id="invoiceGenerateBtn" onClick={generateInvoice} className="px-3 py-1.5 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer">
                Generate next invoice
              </button>
            </div>
            {billing.invoices.length === 0 ? (
              <p className="text-sm text-gray-500">No invoices yet.</p>
            ) : (
              <table className="w-full text-left text-sm" id="invoiceTable">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-gray-500 border-b dark:border-gray-700">
                    <th className="py-2 pr-3">Period</th><th className="py-2 pr-3 text-right">Amount</th><th className="py-2 pr-3">Status</th><th className="py-2">Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {billing.invoices.map((inv) => (
                    <tr key={inv.id} className="invoice-row">
                      <td className="py-2 pr-3 text-xs">{fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{inr(inv.amount)}</td>
                      <td className="py-2 pr-3"><Badge tone={inv.status === 'PAID' ? 'good' : inv.status === 'VOID' ? 'muted' : 'warn'}>{inv.status}</Badge></td>
                      <td className="py-2">
                        {inv.status === 'PENDING' ? (
                          <span className="flex gap-2">
                            <input className="input-base !py-1 text-xs" placeholder="UTR / reference" value={payRef[inv.id] ?? ''} onChange={(e) => setPayRef({ ...payRef, [inv.id]: e.target.value })} />
                            <button type="button" className="invoice-pay px-2 py-1 text-xs font-semibold bg-emerald-600 text-white rounded cursor-pointer disabled:opacity-50" disabled={!(payRef[inv.id] ?? '').trim()} onClick={() => markPaid(inv)}>Mark paid</button>
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">{inv.paymentRef} · {fmtDate(inv.paidAt)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-gray-500">Payments are recorded here after they arrive (bank transfer, UPI or cheque). Recording one extends access by the invoice period.</p>
          </div>
        </Modal>
      )}

      {reveal && (
        <Modal title="Temporary password" onClose={() => setReveal(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300">Give this to <b>{reveal.email}</b>. It is shown only once; they can change it after signing in.</p>
          <div id="revealedPassword" className="my-4 p-3 text-center font-mono text-lg tracking-wider bg-gray-50 dark:bg-gray-900/40 border rounded-lg select-all">{reveal.password}</div>
          <div className="flex justify-end"><button type="button" className="px-4 py-2 text-sm font-semibold bg-purple-600 text-white rounded-lg cursor-pointer" onClick={() => setReveal(null)}>Done</button></div>
        </Modal>
      )}

      {form && (
        <Modal title="Add tenant" onClose={() => setForm(null)}>
          <form onSubmit={createTenant} className="space-y-4">
            {formError && <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg">{formError}</div>}
            <Field label="Business name">
              <input id="tenantName" className="input-base" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="GSTIN (optional)">
                <input className="input-base font-mono" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} maxLength={15} />
              </Field>
              <Field label="Plan">
                <select id="tenantPlan" className="input-base" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value as Plan })}>
                  <option value="TRIAL">Trial — 1 branch</option>
                  <option value="STANDARD">Standard — 3 branches</option>
                  <option value="PRO">Pro — 25 branches</option>
                </select>
              </Field>
            </div>
            <Field label="Branch limit (optional)" hint={`Leave empty for the plan default (${PLAN_DEFAULT_LIMIT[form.plan]}).`}>
              <input className="input-base font-mono" type="number" min="1" max="500" value={form.maxBranches} onChange={(e) => setForm({ ...form, maxBranches: e.target.value })} />
            </Field>
            <div className="border-t pt-4 dark:border-gray-700">
              <div className="text-sm font-semibold mb-3">First Admin (the business owner)</div>
              <div className="space-y-3">
                <Field label="Name">
                  <input id="tenantAdminName" className="input-base" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} required />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Email (sign-in)">
                    <input id="tenantAdminEmail" className="input-base" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} required />
                  </Field>
                  <Field label="Temporary password" hint="At least 8 characters.">
                    <input id="tenantAdminPassword" className="input-base" type="text" minLength={8} value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} required />
                  </Field>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setForm(null)}>Cancel</button>
              <button id="tenantSaveBtn" type="submit" disabled={saving} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
                {saving ? 'Creating…' : 'Create tenant'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Plan & limits — ${editing.tenant.name}`} onClose={() => setEditing(null)}>
          <div className="space-y-4">
            <Field label="Plan">
              <select
                className="input-base"
                value={editing.plan}
                onChange={(e) => {
                  const plan = e.target.value as Plan;
                  setEditing({ ...editing, plan, maxBranches: String(PLAN_DEFAULT_LIMIT[plan]) });
                }}
              >
                <option value="TRIAL">Trial</option>
                <option value="STANDARD">Standard</option>
                <option value="PRO">Pro</option>
              </select>
            </Field>
            <Field label="Branch limit" hint={`${editing.tenant.branchCount} branch(es) in use. Lowering the limit never removes existing branches.`}>
              <input className="input-base font-mono" type="number" min="1" max="500" value={editing.maxBranches} onChange={(e) => setEditing({ ...editing, maxBranches: e.target.value })} />
            </Field>
            <Field label="Access until (optional)" hint={`Extend ${editing.plan === 'TRIAL' ? 'the trial' : 'the paid period'} by hand, e.g. as a goodwill gesture. Currently: ${editing.plan === 'TRIAL' ? fmtDate(editing.tenant.trialEndsAt) : fmtDate(editing.tenant.paidUntil)}.`}>
              <input id="tenantAccessUntil" className="input-base" type="date" value={editing.accessUntil} onChange={(e) => setEditing({ ...editing, accessUntil: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" id="tenantPlanSave" disabled={!editing.maxBranches} className="px-5 py-2 text-sm font-semibold bg-purple-600 disabled:opacity-50 text-white rounded-lg cursor-pointer" onClick={savePlan}>Save</button>
            </div>
          </div>
        </Modal>
      )}

      {suspending && (
        <Modal title={`Suspend ${suspending.name}?`} onClose={() => setSuspending(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            All {suspending.staffCount + suspending.admins.length} accounts of this business are signed out and cannot sign in until you reactivate it. Their data is kept.
          </p>
          <div className="flex justify-end gap-3 pt-4">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setSuspending(null)}>Cancel</button>
            <button id="tenantSuspendOk" type="button" className="px-4 py-2 text-sm font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg cursor-pointer" onClick={() => setActive(suspending, false)}>Suspend</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function friendly(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const fields = parsed?.details?.fieldErrors as Record<string, string[]> | undefined;
    const first = fields && Object.entries(fields).find(([, v]) => v?.length);
    const nested = parsed?.details?.fieldErrors?.admin;
    if (first) return `${first[0]}: ${first[1][0]}`;
    if (nested) return String(nested[0]);
    return parsed.error || raw;
  } catch {
    return raw;
  }
}
