import { Wallet, Receipt, Truck, Landmark, Scale, ChartNoAxesCombined, BookOpen, Percent, Download } from 'lucide-react';
import { useT } from '../i18n';

export const ACCOUNTING_SECTIONS = [
  { label: 'Daily accounts', items: [
    { id: 'cashbook', label: 'Cash Book' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'suppliers', label: 'Suppliers' },
    { id: 'bank', label: 'Bank Transactions' },
  ] },
  { label: 'Reports & export', items: [
    { id: 'tb', label: 'Trial Balance' },
    { id: 'pl', label: 'Profit & Loss' },
    { id: 'bs', label: 'Balance Sheet' },
    { id: 'margin', label: 'Margin' },
    { id: 'tally', label: 'Tally Export' },
  ] },
] as const;

export type AccountingTab = typeof ACCOUNTING_SECTIONS[number]['items'][number]['id'];

const icons = { cashbook: Wallet, expenses: Receipt, suppliers: Truck, bank: Landmark, tb: Scale, pl: ChartNoAxesCombined, bs: BookOpen, margin: Percent, tally: Download };
export const ACCOUNTING_HELP: Record<AccountingTab, string> = {
  cashbook: 'Money received and paid, day by day.', expenses: 'Shop spending and recorded expenses.',
  suppliers: 'Supplier balances, payments and returns.', bank: 'Find recorded bank transactions.',
  tb: 'Check that total debits and credits agree.', pl: 'Income, expenses and profit from your books.',
  bs: 'What the shop owns and owes.', margin: 'Compare selling prices and purchase costs.', tally: 'Download your accounts for Tally.',
};

export function AccountingNavigation({ tab, onChange }: { tab: AccountingTab; onChange: (tab: AccountingTab) => void }) {
  const { t } = useT();
  return (
    <nav aria-label={t('Accounting')}>
      <label className="block lg:hidden text-sm font-semibold">{t('View accounts')}
        <select className="input-base w-full mt-2 min-h-12" value={tab} onChange={(e) => onChange(e.target.value as AccountingTab)}>
          {ACCOUNTING_SECTIONS.map((section) => <optgroup key={section.label} label={t(section.label)}>{section.items.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</optgroup>)}
        </select>
      </label>
      <div className="hidden lg:block space-y-6">
        {ACCOUNTING_SECTIONS.map((section) => (
          <section key={section.label} className="min-w-0">
            <h2 className="mb-2 px-3 text-xs font-semibold text-gray-500">{t(section.label)}</h2>
            <div className="space-y-1">
              {section.items.map((item) => { const Icon = icons[item.id]; return (
                <button key={item.id} id={`acctab-${item.id}`} type="button" aria-pressed={tab === item.id}
                  onClick={() => onChange(item.id)}
                  className={`flex w-full min-h-12 items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-semibold ${tab === item.id ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                  <Icon size={19} aria-hidden="true" className="shrink-0" />
                  {t(item.label)}
                </button>
              ); })}
            </div>
          </section>
        ))}
      </div>
    </nav>
  );
}
