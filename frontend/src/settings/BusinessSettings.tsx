import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Field, Modal, Stat } from '../components/ui';
import { SubscriptionPanel } from '../billing/SubscriptionPanel';

interface PrintJob { id: string; target: string; kind: string; status: 'PENDING' | 'SENT' | 'FAILED'; attempts: number; lastError: string | null; createdAt: string }

interface Branch {
  id: string;
  name: string;
  code: string;
  address: string | null;
  gstin: string | null;
  printerHost: string | null;
  printerPort: number;
  paperWidth: '58mm' | '80mm';
  roundOff: boolean;
  printViaAgent: boolean;
  hasAgentToken: boolean;
  agentOnline: boolean;
}

interface TenantSummary {
  name: string;
  plan: 'TRIAL' | 'STANDARD' | 'PRO';
  maxBranches: number;
  branchCount: number;
  trialEndsAt: string | null;
  paidUntil: string | null;
  access: 'OK' | 'SUSPENDED' | 'TRIAL_EXPIRED' | 'OVERDUE';
  price: string;
}

interface FormState {
  id?: string;
  name: string;
  code: string;
  address: string;
  gstin: string;
  printerHost: string;
  printerPort: string;
  paperWidth: '58mm' | '80mm';
  roundOff: boolean;
  printViaAgent: boolean;
  hasAgentToken: boolean;
  agentOnline: boolean;
}

const blank: FormState = { name: '', code: '', address: '', gstin: '', printerHost: '', printerPort: '9100', paperWidth: '58mm', roundOff: false, printViaAgent: false, hasAgentToken: false, agentOnline: false };

/** Admin (business owner) console: plan usage, branches, GST details and the receipt printer of each branch. */
export function BusinessSettings() {
  const { user } = useAuth();
  const activeBranch = user?.branchId;
  const [jobs, setJobs] = useState<PrintJob[]>([]);

  const loadJobs = useCallback(() => {
    if (!activeBranch) return;
    api.get<{ jobs: PrintJob[] }>(`/print/jobs/${activeBranch}`).then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
  }, [activeBranch]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const retryJob = async (id: string) => {
    try {
      const job = await api.post<PrintJob>(`/print/jobs/${id}/retry`);
      showToast(job.status === 'SENT' ? 'Printed.' : 'Still cannot reach the printer.', job.status === 'SENT' ? 'success' : 'error');
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
    loadJobs();
  };

  const [tenant, setTenant] = useState<TenantSummary | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const createToken = async () => {
    if (!form?.id) return;
    try {
      const res = await api.post<{ token: string }>(`/branches/${form.id}/agent-token`);
      setNewToken(res.token);
      setForm({ ...form, hasAgentToken: true, agentOnline: false });
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const revokeToken = async () => {
    if (!form?.id) return;
    try {
      await api.delete(`/branches/${form.id}/agent-token`);
      setNewToken(null);
      setForm({ ...form, hasAgentToken: false, agentOnline: false, printViaAgent: false });
      load();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, b] = await Promise.all([api.get<TenantSummary>('/tenant/me'), api.get<Branch[]>('/branches')]);
      setTenant(t);
      setBranches(b);
    } catch (err) {
      showToast('Could not load settings: ' + errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const atLimit = !!tenant && tenant.branchCount >= tenant.maxBranches;

  const openEdit = (b: Branch) => {
    setFormError(null);
    setForm({
      id: b.id, name: b.name, code: b.code, address: b.address ?? '', gstin: b.gstin ?? '',
      printerHost: b.printerHost ?? '', printerPort: String(b.printerPort), paperWidth: b.paperWidth, roundOff: b.roundOff,
      printViaAgent: b.printViaAgent, hasAgentToken: b.hasAgentToken, agentOnline: b.agentOnline,
    });
    setNewToken(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) {
        await api.patch(`/branches/${form.id}`, {
          name: form.name.trim(),
          address: form.address.trim() || null,
          gstin: form.gstin.trim() ? form.gstin.trim().toUpperCase() : null,
          printerHost: form.printerHost.trim() || null,
          printerPort: Number(form.printerPort) || 9100,
          paperWidth: form.paperWidth,
          roundOff: form.roundOff,
          printViaAgent: form.printViaAgent,
        });
      } else {
        await api.post('/branches', {
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          ...(form.address.trim() ? { address: form.address.trim() } : {}),
          ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}),
        });
      }
      showToast(form.id ? 'Branch saved.' : 'Branch added.');
      setForm(null);
      load();
    } catch (err) {
      setFormError(friendly(errorMessage(err)));
    } finally {
      setSaving(false);
    }
  };

  /** Saves first so the test uses what is on screen, then prints a test ticket. */
  const testPrint = async () => {
    if (!form?.id) return;
    setTesting(true);
    try {
      await api.patch(`/branches/${form.id}`, {
        printerHost: form.printerHost.trim() || null,
        printerPort: Number(form.printerPort) || 9100,
        paperWidth: form.paperWidth,
        printViaAgent: form.printViaAgent,
      });
      await api.post(`/print/test/${form.id}`);
      showToast(form.printViaAgent ? 'Test ticket queued. It prints when the agent picks it up.' : 'Test ticket sent. Check the printer.');
      load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="max-w-6xl mx-auto space-y-5" id="page-settings">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Business Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Your branches, GST details and receipt printers.</p>
        </div>
        <button
          type="button"
          id="branchAddBtn"
          disabled={atLimit}
          title={atLimit ? 'Branch limit of your plan reached' : undefined}
          onClick={() => { setFormError(null); setForm({ ...blank }); }}
          className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer"
        >
          + Add branch
        </button>
      </div>

      {tenant && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" id="planCard">
          <Stat label="Business" value={<span className="text-lg font-sans">{tenant.name}</span>} />
          <Stat label="Plan" value={tenant.plan} />
          <Stat label="Branches used" value={`${tenant.branchCount} / ${tenant.maxBranches}`} tone={atLimit ? 'warn' : undefined} />
          <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 text-xs text-gray-500">
            {atLimit ? 'You are at your plan limit. Contact support to add more branches.' : 'You can add more branches on your plan.'}
          </div>
        </div>
      )}

      <SubscriptionPanel onChanged={load} />

      {jobs.some((j) => j.status !== 'SENT') && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-amber-300 p-4" id="printQueueCard">
          <h2 className="text-sm font-semibold mb-2">Print queue — these did not reach the printer</h2>
          <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
            {jobs.filter((j) => j.status !== 'SENT').map((j) => (
              <li key={j.id} className="py-2 flex items-center justify-between gap-3">
                <span>
                  <b className="uppercase text-xs">{j.kind}</b> <Badge tone={j.status === 'FAILED' ? 'bad' : 'warn'}>{j.status === 'FAILED' ? 'Gave up' : j.target === 'AGENT' ? 'Waiting for agent' : 'Retrying'}</Badge>
                  <span className="block text-xs text-gray-500">{j.attempts} attempt(s) · {j.lastError}</span>
                </span>
                <button type="button" className="print-retry px-3 py-1 text-xs border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" onClick={() => retryJob(j.id)}>Retry now</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading branches…</div>
        ) : (
          <table className="w-full text-left text-sm" id="branchTable">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                <th className="py-2.5 px-4">Branch</th>
                <th className="py-2.5 px-4">GSTIN</th>
                <th className="py-2.5 px-4">Receipt printer</th>
                <th className="py-2.5 px-4">Round-off</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {branches.map((b) => (
                <tr key={b.id} className="branch-row" data-branch-code={b.code}>
                  <td className="py-3 px-4">
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-gray-500">{b.code}{b.address ? ` · ${b.address}` : ''}</div>
                  </td>
                  <td className="py-3 px-4 font-mono text-xs">{b.gstin ?? <Badge tone="warn">Missing</Badge>}</td>
                  <td className="py-3 px-4 text-xs">
                    {b.printerHost ? <span className="font-mono">{b.printerHost}:{b.printerPort}</span> : <span className="text-gray-500">Browser print</span>}
                    <span className="text-gray-400"> · {b.paperWidth}</span>
                  </td>
                  <td className="py-3 px-4">{b.roundOff ? <Badge tone="info">On</Badge> : <Badge tone="muted">Off</Badge>}</td>
                  <td className="py-3 px-4 text-right">
                    <button type="button" className="text-xs text-purple-600 hover:underline cursor-pointer" onClick={() => openEdit(b)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && (
        <Modal title={form.id ? `Edit ${form.name}` : 'Add branch'} onClose={() => setForm(null)} wide>
          <form onSubmit={save} className="space-y-4">
            {formError && <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg">{formError}</div>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Branch name">
                <input id="branchName" className="input-base" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
              </Field>
              <Field label="Code" hint={form.id ? 'Fixed — it is part of every bill number.' : '2–10 letters/digits, used in bill numbers.'}>
                <input id="branchCode" className="input-base font-mono uppercase" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} disabled={!!form.id} required={!form.id} maxLength={10} />
              </Field>
            </div>
            <Field label="Address (printed on bills)">
              <input className="input-base" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={500} />
            </Field>
            <Field label="GSTIN" hint="Printed on every invoice. The first two digits decide CGST+SGST vs IGST for B2B buyers.">
              <input id="branchGstin" className="input-base font-mono" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} maxLength={15} />
            </Field>

            {form.id && (
              <div className="border-t pt-4 dark:border-gray-700 space-y-3">
                <div className="text-sm font-semibold">Receipt printer</div>
                <div className="grid grid-cols-[1fr_110px_130px] gap-3">
                  <Field label="Printer address" hint="LAN IP or hostname of an ESC/POS printer. Empty = print through the browser.">
                    <input id="printerHost" className="input-base font-mono" placeholder="192.168.1.50" value={form.printerHost} onChange={(e) => setForm({ ...form, printerHost: e.target.value })} />
                  </Field>
                  <Field label="Port">
                    <input id="printerPort" className="input-base font-mono" type="number" min="1" max="65535" value={form.printerPort} onChange={(e) => setForm({ ...form, printerPort: e.target.value })} />
                  </Field>
                  <Field label="Paper">
                    <select id="paperWidth" className="input-base" value={form.paperWidth} onChange={(e) => setForm({ ...form, paperWidth: e.target.value as '58mm' | '80mm' })}>
                      <option value="58mm">58 mm</option>
                      <option value="80mm">80 mm</option>
                    </select>
                  </Field>
                </div>
                <button type="button" id="printerTestBtn" disabled={testing || (!form.printerHost.trim() && !form.printViaAgent)} onClick={testPrint} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 cursor-pointer">
                  {testing ? 'Sending…' : 'Save & send test ticket'}
                </button>
                <div className="rounded-lg border p-3 space-y-3 dark:border-gray-700" id="agentSection">
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input id="printViaAgent" type="checkbox" className="mt-1" checked={form.printViaAgent} disabled={!form.hasAgentToken} onChange={(e) => setForm({ ...form, printViaAgent: e.target.checked })} />
                    <span>
                      Print through the local print agent
                      <span className="block text-xs text-gray-500">For USB, Bluetooth and Windows printers: a small program on the shop PC picks up the jobs. See print-agent/README.md.</span>
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {form.hasAgentToken ? (form.agentOnline ? <Badge tone="good">Agent online</Badge> : <Badge tone="warn">Agent not connected</Badge>) : <Badge tone="muted">No token yet</Badge>}
                    <button type="button" id="agentTokenBtn" className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" onClick={createToken}>
                      {form.hasAgentToken ? 'Replace token' : 'Create token'}
                    </button>
                    {form.hasAgentToken && <button type="button" className="px-3 py-1.5 text-xs text-red-600 hover:underline cursor-pointer" onClick={revokeToken}>Revoke</button>}
                  </div>
                  {newToken && (
                    <div className="text-xs space-y-1" id="agentTokenBox">
                      <div className="text-amber-700">Copy this now. It is shown only once.</div>
                      <div className="p-2 font-mono break-all bg-gray-50 dark:bg-gray-900/40 border rounded select-all" id="agentTokenValue">{newToken}</div>
                    </div>
                  )}
                </div>
                <label className="flex items-start gap-2 text-sm cursor-pointer pt-2">
                  <input type="checkbox" className="mt-1" checked={form.roundOff} onChange={(e) => setForm({ ...form, roundOff: e.target.checked })} />
                  <span>
                    Round bill totals to the nearest rupee
                    <span className="block text-xs text-gray-500">The difference is shown as a “Round off” line and posted to the books. GST is calculated before rounding.</span>
                  </span>
                </label>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2 border-t dark:border-gray-700">
              <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setForm(null)}>Cancel</button>
              <button id="branchSaveBtn" type="submit" disabled={saving} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
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
    if (first) return `${first[0]}: ${first[1][0]}`;
    return parsed.error || raw;
  } catch {
    return raw;
  }
}
