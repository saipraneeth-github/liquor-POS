import {
  Package,
  UploadCloud,
  Landmark,
  ClipboardList,
  ArrowRight,
  Building2,
  CheckCircle2,
} from 'lucide-react';

interface OfficeAdminViewProps {
  shopName: string;
  onNavigate: (route: string) => void;
}

export function OfficeAdminView({ shopName, onNavigate }: OfficeAdminViewProps) {
  const sections = [
    {
      id: 'section-inventory',
      title: 'Inventory Screen',
      tag: 'Store Stock',
      icon: Package,
      color: 'text-emerald-600 dark:text-emerald-400',
      bgColor: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800',
      btnColor: 'bg-emerald-600 hover:bg-emerald-700 text-white',
      description: 'View and manage physical bottle quantities, track brand-wise stock levels, low-stock reorder points, and log bottle breakage.',
      details: [
        'Live bottle counts across all categories',
        'Reorder alerts & stock valuation',
        'Breakage and wastage compliance logs',
      ],
      route: '/inventory',
      actionLabel: 'Open Inventory Screen',
    },
    {
      id: 'section-upload',
      title: 'Upload Screen',
      tag: 'Supplier Invoices',
      icon: UploadCloud,
      color: 'text-blue-600 dark:text-blue-400',
      bgColor: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800',
      btnColor: 'bg-blue-600 hover:bg-blue-700 text-white',
      description: 'Upload supplier purchase invoices to inward stock directly into the catalog. Optical scanner automatically parses line items and tax calculations.',
      details: [
        'Accepted formats: CSV, Excel (.xlsx, .xls), PDF invoices, and photo bills (JPG/PNG)',
        'Supports file sizes up to 15 MB per upload',
        'Auto-extracts supplier, invoice number, items, and tax breakdown',
      ],
      route: '/inventory?tab=upload',
      actionLabel: 'Open Upload Screen',
    },
    {
      id: 'section-bank',
      title: 'Bank Statement Upload Screen',
      tag: 'Bank Statements',
      icon: Landmark,
      color: 'text-purple-600 dark:text-purple-400',
      bgColor: 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-800',
      btnColor: 'bg-purple-600 hover:bg-purple-700 text-white',
      description: 'Upload bank statements to reconcile bank balances, card & UPI settlements from POS machines, inward vendor payouts, and bank charges.',
      details: [
        'Accepted formats: PDF statements, CSV, and Excel spreadsheets (.xlsx, .xls)',
        'Compatible with all Indian banks (SBI, HDFC, ICICI, Axis, etc.)',
        'Automatic balance chain verification and fee gap reconciliation',
      ],
      route: '/bank',
      actionLabel: 'Open Bank Upload Screen',
    },
    {
      id: 'section-counter',
      title: 'Counter Screen',
      tag: 'Get Stock & Sales',
      icon: ClipboardList,
      color: 'text-amber-600 dark:text-amber-400',
      bgColor: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800',
      btnColor: 'bg-amber-600 hover:bg-amber-700 text-white',
      description: 'Access counter-related features. Open daily "Get Stock" sheets, enter physical stock present, calculate sold bottles, and post audit reconciliations.',
      details: [
        'Get Stock sheets: Opening + Inward − Physical Stock Present = Sold',
        'Physical bottle count entry and surplus/shortage detection',
        'Excel and CSV export of physical stock records',
      ],
      route: '/counter',
      actionLabel: 'Open Counter Screen',
    },
  ];

  return (
    <div className="space-y-6" id="officeAdminPortal">
      {/* Welcome Banner */}
      <div className="bg-gradient-to-r from-emerald-800 via-teal-900 to-slate-900 text-white p-6 md:p-8 rounded-2xl shadow-lg relative overflow-hidden">
        <div className="relative z-10 max-w-3xl space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 text-xs font-semibold tracking-wide uppercase">
            <Building2 size={13} />
            <span>Office Admin Portal</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold font-display tracking-tight text-white" id="officeAdminWelcome">
            Welcome to {shopName}
          </h1>
          <p className="text-emerald-100/90 text-sm md:text-base leading-relaxed">
            Your centralized office workspace for managing inventory, inward supplier invoice uploads, bank statement reconciliation, and daily counter stock sheets.
          </p>
        </div>
        <div className="absolute -right-6 -bottom-8 opacity-10 pointer-events-none text-white">
          <Building2 size={220} />
        </div>
      </div>

      {/* Navigation / Sections Grid */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Navigation &amp; Operations
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Select any of the sections below to access management tools.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5" id="officeAdminSections">
          {sections.map((sec) => {
            const IconComp = sec.icon;
            return (
              <div
                key={sec.id}
                id={sec.id}
                className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 flex flex-col justify-between hover:shadow-md transition-shadow group"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2.5 rounded-lg border ${sec.bgColor} ${sec.color}`}>
                        <IconComp size={22} />
                      </div>
                      <div>
                        <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                          {sec.tag}
                        </span>
                        <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                          {sec.title}
                        </h3>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                    {sec.description}
                  </p>

                  <div className="bg-gray-50 dark:bg-gray-750/50 p-3 rounded-lg border border-gray-100 dark:border-gray-700/60 space-y-1.5">
                    {sec.details.map((d, idx) => (
                      <div key={idx} className="flex items-start gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                        <CheckCircle2 size={13} className="text-emerald-500 shrink-0 mt-0.5" />
                        <span>{d}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-4 mt-2 border-t border-gray-100 dark:border-gray-700/60 flex items-center justify-between">
                  <span className="text-[11px] text-gray-400 font-mono">
                    {sec.route}
                  </span>
                  <button
                    type="button"
                    onClick={() => onNavigate(sec.route)}
                    className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors ${sec.btnColor}`}
                  >
                    <span>{sec.actionLabel}</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
