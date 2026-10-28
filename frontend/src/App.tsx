import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Login } from './auth/Login';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { Layout } from './components/Layout';
import { POS } from './pos/POS';

// Remaining Placeholder components
const Dashboard = () => <div id="page-dashboard">Dashboard</div>;
const Shift = () => <div id="page-shift">Shift</div>;
const Bills = () => <div id="page-bills">Bills</div>;
const Customers = () => <div id="page-customers">Customers</div>;
const Tables = () => <div id="page-tables">Tables</div>;
const Products = () => <div id="page-products">Products</div>;
const Inventory = () => <div id="page-stock">Inventory</div>;
const Counter = () => <div id="page-counter">Counter Sheet</div>;
const Schemes = () => <div id="page-schemes">Schemes</div>;
const Compliance = () => <div id="page-compliance">Compliance</div>;
const Accounting = () => <div id="page-accounting">Accounting</div>;
const Closing = () => <div id="page-closing">Closing</div>;
const Admin = () => <div id="page-admin">Admin</div>;

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

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
              <Route path="/counter" element={<Counter />} />
              <Route path="/schemes" element={<Schemes />} />
              <Route path="/compliance" element={<Compliance />} />
              <Route path="/accounting" element={<Accounting />} />
              <Route path="/closing" element={<Closing />} />
              <Route path="/admin" element={<Admin />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
