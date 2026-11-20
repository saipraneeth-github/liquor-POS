import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { LanguageProvider } from './i18n';
import { AuthProvider } from './auth/AuthProvider';
import { LoadingProvider } from './context/LoadingContext';
import { Login } from './auth/Login';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { Layout } from './components/Layout';
import { POS } from './pos/POS';
import { Dashboard } from './dashboard/Dashboard';   // the new look: attention strip, role views
import { ForgotPassword } from './auth/ForgotPassword';
import { ResetPassword } from './auth/ResetPassword';
import { ErrorBoundary } from './components/ErrorBoundary';

// Every screen except sign-in, the dashboard and the POS is loaded when first opened, so a cashier's tablet does not
// download the Super Admin console, bank reconciliation or invoice OCR screens. The POS stays in the main bundle on
// purpose: a cashier who goes offline mid-shift cannot fetch a chunk, and the POS must already be there.
function screen<M extends Record<string, any>>(load: () => Promise<M>, name: keyof M & string) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const Bills = screen(() => import('./bills/Bills'), 'Bills');
const Tables = screen(() => import('./tables/Tables'), 'Tables');
const Ledger = screen(() => import('./accounting/Ledger'), 'Ledger');
const Customers = screen(() => import('./customers/Customers'), 'Customers');
const Counter = screen(() => import('./counter/Counter'), 'Counter');
const Shift = screen(() => import('./shifts/Shift'), 'Shift');
const Products = screen(() => import('./products/Products'), 'Products');
const Inventory = screen(() => import('./inventory/Inventory'), 'Inventory');
const InvoiceUpload = screen(() => import('./invoices/InvoiceUpload'), 'InvoiceUpload');
const KitchenMenu = screen(() => import('./menu/KitchenMenu'), 'KitchenMenu');
const BarMenu = screen(() => import('./menu/BarMenu'), 'BarMenu');
const Closing = screen(() => import('./closing/Closing'), 'Closing');
const BankReconciliation = screen(() => import('./bank/BankReconciliation'), 'BankReconciliation');
const Schemes = screen(() => import('./schemes/Schemes'), 'Schemes');
const Compliance = screen(() => import('./compliance/Compliance'), 'Compliance');
const Admin = screen(() => import('./admin/Admin'), 'Admin');
const Platform = screen(() => import('./platform/Platform'), 'Platform');
const PlatformUsers = screen(() => import('./platform/PlatformUsers'), 'PlatformUsers');
const PlatformPlans = screen(() => import('./platform/PlatformPlans'), 'PlatformPlans');
const PlatformBranches = screen(() => import('./platform/PlatformBranches'), 'PlatformBranches');
const PlatformRoles = screen(() => import('./platform/PlatformRoles'), 'PlatformRoles');
const PlatformAudit = screen(() => import('./platform/PlatformAudit'), 'PlatformAudit');
const PlatformErrors = screen(() => import('./platform/PlatformErrors'), 'PlatformErrors');
const PlatformMaster = screen(() => import('./platform/PlatformMaster'), 'PlatformMaster');
const BusinessSettings = screen(() => import('./settings/BusinessSettings'), 'BusinessSettings');
const PourControl = screen(() => import('./pour/PourControl'), 'PourControl');

function ScreenLoading() {
  return <div role="status" aria-live="polite" className="p-8 text-sm text-gray-500">Loading…</div>;
}


export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
       <LanguageProvider>
        <AuthProvider>
          <LoadingProvider>
            <ErrorBoundary>
              <Suspense fallback={<ScreenLoading />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />

                <Route element={<ProtectedRoute />}>
                  <Route element={<Layout />}>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/pos" element={<POS />} />
                    <Route path="/shift" element={<Shift />} />
                    <Route path="/bills" element={<Bills />} />
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/tables" element={<Tables />} />
                    <Route path="/products" element={<Products />} />
                    <Route path="/invoices" element={<InvoiceUpload />} />
                    <Route path="/inventory" element={<Inventory />} />
                    <Route path="/menu/kitchen" element={<KitchenMenu />} />
                    <Route path="/menu/bar" element={<BarMenu />} />
                    <Route path="/counter" element={<Counter />} />
                    <Route path="/schemes" element={<Schemes />} />
                    <Route path="/compliance" element={<Compliance />} />
                    <Route path="/accounting" element={<Ledger />} />
                    <Route path="/bank" element={<BankReconciliation />} />
                    <Route path="/closing" element={<Closing />} />
                    <Route path="/admin" element={<Admin />} />
                    <Route path="/pour" element={<PourControl />} />
                    <Route path="/settings" element={<BusinessSettings />} />
                    <Route path="/platform" element={<Platform />} />
                    <Route path="/platform/roles" element={<PlatformRoles />} />
                    <Route path="/platform/branches" element={<PlatformBranches />} />
                    <Route path="/platform/plans" element={<PlatformPlans />} />
                    <Route path="/platform/users" element={<PlatformUsers />} />
                    <Route path="/platform/master" element={<PlatformMaster />} />
                    <Route path="/platform/audit" element={<PlatformAudit />} />
                    <Route path="/platform/errors" element={<PlatformErrors />} />
                  </Route>
                </Route>

                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              </Suspense>
            </ErrorBoundary>
            {/* Right-Side High-Prominence Toast Container */}
            <div
              id="toastHost"
              className="fixed top-6 right-6 z-[10000] flex flex-col items-end gap-3 pointer-events-none w-auto max-w-lg"
            />
          </LoadingProvider>
        </AuthProvider>
       </LanguageProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
