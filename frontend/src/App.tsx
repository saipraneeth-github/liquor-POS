import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Login } from './auth/Login';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { Layout } from './components/Layout';
import { POS } from './pos/POS';
import { Bills } from './bills/Bills';
import { Tables } from './tables/Tables';
import { Ledger } from './accounting/Ledger';
import { Customers } from './customers/Customers';
import { Counter } from './counter/Counter';
import { Shift } from './shifts/Shift';
import { Products } from './products/Products';
import { Inventory } from './inventory/Inventory';
import { KitchenMenu } from './menu/KitchenMenu';
import { BarMenu } from './menu/BarMenu';
import { Closing } from './closing/Closing';
import { Schemes } from './schemes/Schemes';
import { Compliance } from './compliance/Compliance';
import { Dashboard } from './dashboard/Dashboard';
import { Admin } from './admin/Admin';
import { ForgotPassword } from './auth/ForgotPassword';
import { ResetPassword } from './auth/ResetPassword';
import { Platform } from './platform/Platform';
import { BusinessSettings } from './settings/BusinessSettings';
import { PourControl } from './pour/PourControl';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/menu/kitchen" element={<KitchenMenu />} />
              <Route path="/menu/bar" element={<BarMenu />} />
              <Route path="/counter" element={<Counter />} />
              <Route path="/schemes" element={<Schemes />} />
              <Route path="/compliance" element={<Compliance />} />
              <Route path="/accounting" element={<Ledger />} />
              <Route path="/closing" element={<Closing />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/pour" element={<PourControl />} />
              <Route path="/settings" element={<BusinessSettings />} />
              <Route path="/platform" element={<Platform />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <div id="toastHost" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none" />
      </AuthProvider>
    </BrowserRouter>
  );
}
