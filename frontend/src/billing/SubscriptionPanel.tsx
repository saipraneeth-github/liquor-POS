import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';
import { Badge, Modal, inr } from '../components/ui';

export interface TenantSummary {
  name: string;
  plan: 'TRIAL' | 'STANDARD' | 'PRO';
  maxBranches: number;
  branchCount: number;
  trialEndsAt: string | null;
  paidUntil: string | null;
  access: 'OK' | 'SUSPENDED' | 'TRIAL_EXPIRED' | 'OVERDUE';
  price: string;
}

export interface Invoice {
  id: string;
  plan: string;
  amount: string;
  periodStart: string;
  periodEnd: string;
  status: 'PENDING' | 'PAID' | 'VOID';
  paymentRef: string | null;
}

interface Checkout {
  provider: 'razorpay' | 'mock';
  keyId: string | null;
  orderId: string;
  amountPaise: number;
  currency: string;
  invoiceAmount: string;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (r: unknown) => void) => void };
  }
}

const day = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://checkout.razorpay.com/v1/checkout.js';
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Could not load the payment window. Check your internet connection.'));
    document.head.appendChild(el);
  });
}

const PLAN_CARDS = [
  { plan: 'STANDARD' as const, price: '2,999', branches: 3, blurb: 'Up to 3 branches' },
  { plan: 'PRO' as const, price: '7,999', branches: 25, blurb: 'Up to 25 branches' },
];

/** Plan, invoices and online payment. Used in Business Settings and on the lock screen of an expired tenant. */
export function SubscriptionPanel({ onChanged, showPlans }: { onChanged?: () => void; showPlans?: boolean }) {
  const [tenant, setTenant] = useState<TenantSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [testPay, setTestPay] = useState<Checkout | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, i] = await Promise.all([api.get<TenantSummary>('/tenant/me'), api.get<{ invoices: Invoice[] }>('/tenant/invoices')]);
      setTenant(t);
      setInvoices(i.invoices);
    } catch (err) {
      showToast('Could not load billing: ' + errorMessage(err), 'error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const paid = async () => {
    showToast('Payment received. Thank you!');
    setTestPay(null);
    await load();
    onChanged?.();
  };

  const verify = async (p: { orderId: string; paymentId: string; signature: string }) => {
    try {
      await api.post('/tenant/payments/verify', p);
      await paid();
    } catch (err) {
      showToast('Payment could not be confirmed: ' + errorMessage(err), 'error');
    }
  };

  const payNow = async (invoice: Invoice) => {
    setBusy(invoice.id);
    try {
      const checkout = await api.post<Checkout>(`/tenant/invoices/${invoice.id}/pay-online`);
      if (checkout.provider === 'mock') {
        setTestPay(checkout);
        return;
      }
      await loadRazorpayScript();
      const rzp = new window.Razorpay!({
        key: checkout.keyId,
        order_id: checkout.orderId,
        amount: checkout.amountPaise,
        currency: checkout.currency,
        name: 'Liquor Counter',
        description: `${invoice.plan} plan, ${day(invoice.periodStart)} to ${day(invoice.periodEnd)}`,
        theme: { color: '#7c3aed' },
        handler: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
          verify({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
      });
      rzp.on('payment.failed', () => showToast('The payment did not go through. You can try again.', 'error'));
      rzp.open();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    if (!testPay) return;
    try {
      const signed = await api.post<{ orderId: string; paymentId: string; signature: string }>('/tenant/payments/mock-pay', { orderId: testPay.orderId });
      await verify(signed);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const renew = async () => {
    setBusy('renew');
    try {
      await api.post('/tenant/invoices/renew');
      await load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const choosePlan = async (plan: 'STANDARD' | 'PRO') => {
    setBusy(plan);
    try {
      await api.post('/tenant/plan', { plan });
      await load();
      onChanged?.();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!tenant) return <div className="text-sm text-gray-500 p-4">Loading billing…</div>;
  const pending = invoices.find((i) => i.status === 'PENDING');
  const standing =
    tenant.access === 'OK' ? <Badge tone="good">In good standing</Badge>
    : tenant.access === 'OVERDUE' ? <Badge tone="bad">Payment overdue</Badge>
    : tenant.access === 'TRIAL_EXPIRED' ? <Badge tone="bad">Trial ended</Badge>
    : <Badge tone="bad">Suspended</Badge>;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 space-y-4" id="billingCard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <b>{tenant.plan}</b> plan{tenant.plan !== 'TRIAL' && <> · {inr(tenant.price)} / month</>} ·{' '}
          {tenant.plan === 'TRIAL' ? `trial ends ${day(tenant.trialEndsAt)}` : tenant.paidUntil ? `paid until ${day(tenant.paidUntil)}` : 'billed manually'}
        </div>
        {standing}
      </div>

      {(showPlans || tenant.plan === 'TRIAL') && (
        <div className="grid sm:grid-cols-2 gap-3" id="planChoices">
          {PLAN_CARDS.map((p) => (
            <div key={p.plan} className={`rounded-lg border p-3 ${tenant.plan === p.plan ? 'border-purple-400 bg-purple-50/40' : ''}`}>
              <div className="flex items-baseline justify-between">
                <b>{p.plan === 'STANDARD' ? 'Standard' : 'Pro'}</b>
                <span className="font-mono">₹{p.price}<span className="text-xs text-gray-500"> / month</span></span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{p.blurb}, GST included</div>
              <button
                type="button"
                className={`plan-choose mt-3 w-full py-1.5 text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-50 ${tenant.plan === p.plan ? 'border text-gray-600' : 'bg-purple-600 hover:bg-purple-700 text-white'}`}
                disabled={busy !== null}
                onClick={() => choosePlan(p.plan)}
              >
                {tenant.plan === p.plan ? 'Current plan' : `Choose ${p.plan === 'STANDARD' ? 'Standard' : 'Pro'}`}
              </button>
            </div>
          ))}
        </div>
      )}

      {pending && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 p-3" id="dueInvoice">
          <div className="text-sm">
            <b>{inr(pending.amount)}</b> due for {day(pending.periodStart)} – {day(pending.periodEnd)}
          </div>
          <button type="button" id="payNowBtn" disabled={busy === pending.id} onClick={() => payNow(pending)} className="px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg cursor-pointer disabled:opacity-50">
            {busy === pending.id ? 'Opening…' : 'Pay now'}
          </button>
        </div>
      )}
      {!pending && tenant.plan !== 'TRIAL' && (
        <button type="button" id="renewBtn" disabled={busy !== null} onClick={renew} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer disabled:opacity-50">
          Renew early
        </button>
      )}

      {invoices.length > 0 && (
        <table className="w-full text-left text-sm" id="myInvoices">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {invoices.slice(0, 6).map((inv) => (
              <tr key={inv.id} className="my-invoice">
                <td className="py-1.5 text-xs">{day(inv.periodStart)} – {day(inv.periodEnd)}</td>
                <td className="py-1.5 text-right font-mono">{inr(inv.amount)}</td>
                <td className="py-1.5 pl-3"><Badge tone={inv.status === 'PAID' ? 'good' : inv.status === 'VOID' ? 'muted' : 'warn'}>{inv.status === 'PENDING' ? 'DUE' : inv.status}</Badge></td>
                <td className="py-1.5 pl-3 text-xs text-gray-500">{inv.paymentRef ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {testPay && (
        <Modal title="Test payment" onClose={() => setTestPay(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            No payment gateway is connected yet, so this is a <b>test payment</b>: no money moves.
            Once Razorpay is configured, this opens the real checkout (UPI, cards, netbanking).
          </p>
          <div className="my-4 text-center text-2xl font-mono">{inr(testPay.invoiceAmount)}</div>
          <div className="flex justify-end gap-3">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer" onClick={() => setTestPay(null)}>Cancel</button>
            <button type="button" id="simulatePayBtn" className="px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg cursor-pointer" onClick={simulate}>Simulate successful payment</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
