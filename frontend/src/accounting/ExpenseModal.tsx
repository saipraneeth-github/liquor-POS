import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Field, Modal } from '../components/ui';
import { useT } from '../i18n';
import { businessDate } from '../lib/business-day';
import { errorMessage } from '../lib/print';

const categories = ['Rent', 'Wages', 'Electricity', 'Transport', 'Tea', 'Supplies'];
const modes = [['CASH', 'Cash (from drawer)'], ['UPI', 'UPI'], ['CARD', 'Card'], ['BANK', 'Bank']] as const;

/** Shared entry form. The selected shop is fixed for this submission, even if the dashboard changes. */
export function ExpenseModal({ initialBranchId, onClose, onSaved }: {
  initialBranchId: string; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useT();
  const { user, branches } = useAuth();
  const [branchId, setBranchId] = useState(initialBranchId);
  const [category, setCategory] = useState('');
  const [customCategory, setCustomCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMode, setPaymentMode] = useState('CASH');
  const [expenseDate, setExpenseDate] = useState(businessDate());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const amountInput = useRef<HTMLInputElement>(null);
  useEffect(() => { amountInput.current?.focus(); }, []);
  const canChooseShop = user?.role === 'owner' && !!user.syndicateId;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    const name = (category === 'OTHER' ? customCategory : category).trim();
    if (!branchId) { setError(t('Choose the shop for this expense.')); return; }
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(amount.trim()) || !/[1-9]/.test(amount)) {
      setError(t('Enter an amount above zero, with up to two decimal places.')); return;
    }
    if (name.length < 2 || name.length > 60 || !/[A-Za-z0-9]/.test(name)) {
      setError(t('Use 2 to 60 characters for the category, including an English letter or number.')); return;
    }
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      await api.post(`/expenses/${branchId}`, { category: name, amount: amount.trim(), paymentMode, expenseDate, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      onSaved();
    } catch (err) { setError(t(errorMessage(err))); }
    finally { submitting.current = false; setSaving(false); }
  };
  return <Modal title={t('Record expense')} onClose={() => { if (!submitting.current) onClose(); }}>
    <form id="expenseForm" onSubmit={save} className="space-y-5">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('Record money spent for the shop.')}</p>
      <fieldset disabled={saving} className="space-y-4 min-w-0">
        {canChooseShop ? <Field label={t('Shop')}><select id="expBranch" className="input-base w-full min-h-11" required value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">{t('Choose a shop')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          : <p className="rounded-lg bg-gray-50 dark:bg-gray-900 p-3 text-sm"><span className="text-gray-500">{t('Shop')}: </span><strong>{branches.find((b) => b.id === branchId)?.name ?? t('Your shop')}</strong></p>}
        <Field label={t('Amount (₹)')}><input ref={amountInput} id="expAmount" required inputMode="decimal" autoComplete="off" className="input-base w-full min-h-14 text-2xl font-semibold tabular-nums" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby={error ? 'expenseError' : undefined} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Category')}><select id="expCategory" required className="input-base w-full min-h-11" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">{t('Choose a category')}</option>{categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}<option value="OTHER">{t('Other')}</option></select></Field>
          <Field label={t('Date')}><input id="expDate" type="date" required className="input-base w-full min-h-11" max={businessDate()} value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} /></Field>
        </div>
        {category === 'OTHER' && <Field label={t('Category name')}><input id="expCustomCategory" required minLength={2} maxLength={60} className="input-base w-full min-h-11" value={customCategory} onChange={(e) => setCustomCategory(e.target.value)} /></Field>}
        <fieldset><legend className="mb-2 text-sm font-semibold">{t('Paid by')}</legend><div className="grid grid-cols-2 gap-2">{modes.map(([value, label]) => <label key={value} className={`flex min-h-12 items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer ${paymentMode === value ? 'border-purple-600 bg-purple-50 dark:bg-purple-950/30' : 'border-gray-300 dark:border-gray-600'}`}><input type="radio" name="expenseMode" value={value} checked={paymentMode === value} onChange={() => setPaymentMode(value)} />{t(label)}</label>)}</div></fieldset>
        <Field label={t('Note (optional)')}><textarea id="expNotes" rows={2} maxLength={500} className="input-base w-full" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </fieldset>
      {error && <p id="expenseError" role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-800 dark:text-red-200">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
        <button type="button" disabled={saving} onClick={onClose} className="min-h-11 rounded-lg border border-gray-300 dark:border-gray-600 px-5 py-2">{t('Cancel')}</button>
        <button id="expSave" disabled={saving} type="submit" className="min-h-11 rounded-lg bg-purple-600 px-5 py-2 font-semibold text-white hover:bg-purple-700 disabled:opacity-60">{t(saving ? 'Saving…' : 'Save expense')}</button>
      </div>
    </form>
  </Modal>;
}
