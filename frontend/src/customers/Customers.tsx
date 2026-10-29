import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface Customer {
  id: string;
  name: string;
  phone: string;
  creditAllowed: boolean;
  creditLimit: string;
  currentCredit: string;
  isActive: boolean;
}

interface StatementEntry {
  id: string;
  type: string;
  amount: string;
  paymentMode?: string;
  runningBalance: string;
  recordedAt: string;
  notes?: string;
}

interface StatementResponse {
  customer: Customer;
  outstanding: string;
  entries: StatementEntry[];
}

export function Customers() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadingCust, setLoadingCust] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [outstandingTotal, setOutstandingTotal] = useState<{ totalOutstanding: string; count: number } | null>(null);

  // New customer form
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [newAllow, setNewAllow] = useState(false);
  const [creating, setCreating] = useState(false);

  // Repayment form
  const [repayAmount, setRepayAmount] = useState('');
  const [repayMode, setRepayMode] = useState('CASH');
  const [repayNotes, setRepayNotes] = useState('');
  const [repaying, setRepaying] = useState(false);

  // Manager credit settings
  const [ecLimit, setEcLimit] = useState('');
  const [ecAllow, setEcAllow] = useState(false);
  const [ecActive, setEcActive] = useState(true);

  const branchId = user?.branchId;
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${type === 'error' ? 'bg-red-600' : 'bg-emerald-600'} text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadCustomers = async () => {
    if (!branchId) return;
    setLoadingCust(true);
    try {
      const q = search.trim();
      const res = await api.get<{ customers: Customer[] }>(
        `/customers/${branchId}?limit=100${q ? '&search=' + encodeURIComponent(q) : ''}`
      );
      setCustomers(res.customers);
    } catch (err: any) {
      showToast(err.message || 'Failed to load customers', 'error');
    } finally {
      setLoadingCust(false);
    }
  };

  const loadOutstanding = async () => {
    if (!branchId || !isManager) return;
    try {
      const res = await api.get<{ totalOutstanding: string; count: number }>(`/customers/${branchId}/outstanding`);
      setOutstandingTotal(res);
    } catch {
      // Quiet fail
    }
  };

  useEffect(() => {
    loadCustomers();
    loadOutstanding();
  }, [branchId]);

  const openStatement = async (id: string) => {
    setLoadingStatement(true);
    try {
      const res = await api.get<StatementResponse>(`/customers/${id}/statement`);
      setSelectedCustomer(res.customer);
      setStatement(res);
      setEcLimit(res.customer.creditLimit);
      setEcAllow(res.customer.creditAllowed);
      setEcActive(res.customer.isActive);
    } catch (err: any) {
      showToast(err.message || 'Failed to load statement', 'error');
    } finally {
      setLoadingStatement(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) {
      showToast('Select a branch first.', 'error');
      return;
    }
    const phoneTrimmed = newPhone.trim();
    if (!/^[6-9]\d{9}$/.test(phoneTrimmed)) {
      showToast('Enter a 10-digit mobile number starting with 6–9.', 'error');
      return;
    }
    const body: any = {
      name: newName.trim(),
      phone: phoneTrimmed,
    };
    if (isManager) {
      const limitTrimmed = newLimit.trim();
      if (limitTrimmed) body.creditLimit = limitTrimmed;
      if (newAllow) body.creditAllowed = true;
    }
    setCreating(true);
    try {
      const res = await api.post<{ customer: Customer }>(`/customers/${branchId}`, body);
      showToast('Customer created: ' + res.customer.name, 'success');
      setNewName('');
      setNewPhone('');
      setNewLimit('');
      setNewAllow(false);
      setSearch(res.customer.name);
      await loadCustomers();
      openStatement(res.customer.id);
    } catch (err: any) {
      showToast('Could not create customer: ' + err.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRepayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer) return;
    const amt = parseFloat(repayAmount.trim());
    if (isNaN(amt) || amt <= 0) {
      showToast('Enter a repayment amount greater than zero.', 'error');
      return;
    }
    setRepaying(true);
    try {
      const clientRef = crypto.randomUUID();
      const body: any = {
        amount: repayAmount.trim(),
        paymentMode: repayMode,
        clientRef,
      };
      if (repayNotes.trim()) body.notes = repayNotes.trim();

      const res = await api.post<{ customer: Customer }>(`/customers/${selectedCustomer.id}/repayments`, body);
      showToast(`Repayment recorded — outstanding now ₹${parseFloat(res.customer.currentCredit).toFixed(2)}`, 'success');
      setRepayAmount('');
      setRepayNotes('');
      await openStatement(selectedCustomer.id);
      loadCustomers();
      if (isManager) loadOutstanding();
    } catch (err: any) {
      showToast('Repayment failed: ' + err.message, 'error');
    } finally {
      setRepaying(false);
    }
  };

  const handleUpdateCredit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer) return;
    try {
      await api.patch(`/customers/${selectedCustomer.id}`, {
        creditLimit: ecLimit.trim(),
        creditAllowed: ecAllow,
        isActive: ecActive,
      });
      showToast('Credit settings saved', 'success');
      openStatement(selectedCustomer.id);
      loadCustomers();
    } catch (err: any) {
      showToast('Update failed: ' + err.message, 'error');
    }
  };

  const remainingCredit = selectedCustomer
    ? parseFloat(selectedCustomer.creditLimit || '0') - parseFloat(selectedCustomer.currentCredit || '0')
    : 0;

  return (
    <section className="page active" id="page-customers" aria-labelledby="custTitle">
      <h2 className="h1 text-xl font-bold mb-4" id="custTitle">📒 Customers &amp; Khata</h2>
      <div className="two-col grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="stack flex flex-col gap-4">
          <div className="card pad p-4 bg-white rounded shadow flex flex-col gap-4">
            <div className="row flex gap-2">
              <label htmlFor="custSearch" className="sr-only">Search customers</label>
              <input
                id="custSearch"
                className="input grow p-2 border rounded"
                style={{ width: 'auto' }}
                placeholder="Search by name or phone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    loadCustomers();
                  }
                }}
              />
              <button
                className="btn-primary px-4 py-2 bg-blue-600 text-white rounded font-medium"
                type="button"
                id="custSearchBtn"
                onClick={loadCustomers}
              >
                Search
              </button>
            </div>

            <div id="custList">
              {loadingCust ? (
                <div className="p-4 text-gray-500">Loading customers...</div>
              ) : customers.length === 0 ? (
                <div className="state p-4 text-gray-500 text-center">
                  {search ? 'No customers match.' : 'No customers yet.'}
                </div>
              ) : (
                <div className="table-wrap overflow-x-auto">
                  <table className="table table-compact w-full text-left">
                    <thead>
                      <tr className="border-b">
                        <th className="py-2">Customer</th>
                        <th className="py-2">Credit</th>
                        <th className="py-2 text-right">Outstanding</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {customers.map((c) => (
                        <tr
                          key={c.id}
                          className={`cust-row border-b hover:bg-gray-50 ${selectedCustomer?.id === c.id ? 'row-active bg-blue-50' : ''}`}
                          data-name={c.name}
                        >
                          <td className="py-2">
                            <b>{c.name}</b>
                            <div className="muted small text-xs text-gray-500">{c.phone}</div>
                          </td>
                          <td className="py-2">
                            {c.creditAllowed ? (
                              <span className="badge blue bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded">
                                Limit ₹{parseFloat(c.creditLimit).toFixed(2)}
                              </span>
                            ) : (
                              <span className="badge yellow bg-yellow-100 text-yellow-800 text-xs px-2 py-0.5 rounded">
                                No credit
                              </span>
                            )}{' '}
                            {!c.isActive && (
                              <span className="badge red bg-red-100 text-red-800 text-xs px-2 py-0.5 rounded">
                                Inactive
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right font-mono">
                            ₹{parseFloat(c.currentCredit).toFixed(2)}
                          </td>
                          <td className="py-2 text-right" style={{ width: '1%', whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              className="btn-sec btn-sm px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 text-xs rounded border"
                              onClick={() => openStatement(c.id)}
                            >
                              Statement
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <details className="card p-4 bg-white rounded shadow" id="custCreateBox">
            <summary className="font-semibold cursor-pointer">+ New customer</summary>
            <div className="pad pt-4">
              <form className="form-grid flex flex-col gap-3" id="custCreateForm" onSubmit={handleCreateCustomer}>
                <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="custName">
                  Name
                  <input
                    id="custName"
                    className="input p-2 border rounded"
                    required
                    maxLength={200}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </label>
                <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="custPhone">
                  Mobile
                  <input
                    id="custPhone"
                    className="input p-2 border rounded"
                    required
                    inputMode="numeric"
                    pattern="[6-9][0-9]{9}"
                    maxLength={10}
                    title="10-digit Indian mobile number starting with 6-9"
                    placeholder="10-digit mobile"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                  />
                </label>
                {isManager && (
                  <>
                    <label className="field mgr-only flex flex-col gap-1 text-sm font-medium" htmlFor="custLimit">
                      Credit limit (₹)
                      <input
                        id="custLimit"
                        className="input p-2 border rounded"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={newLimit}
                        onChange={(e) => setNewLimit(e.target.value)}
                      />
                    </label>
                    <label className="check mgr-only flex items-center gap-2 text-sm" htmlFor="custAllow">
                      <input
                        id="custAllow"
                        type="checkbox"
                        checked={newAllow}
                        onChange={(e) => setNewAllow(e.target.checked)}
                      />
                      Allow credit
                    </label>
                  </>
                )}
                <button
                  className="btn-primary mt-2 px-4 py-2 bg-blue-600 text-white rounded font-medium disabled:opacity-50"
                  type="submit"
                  id="custCreateBtn"
                  disabled={creating}
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </form>
            </div>
          </details>

          {outstandingTotal && (
            <div id="custOutstandingBox">
              <div className="card pad p-4 bg-white rounded shadow">
                <div className="stat-label text-xs uppercase tracking-wider text-gray-500">Total khata outstanding</div>
                <div className="stat-value font-mono text-2xl font-bold">₹{parseFloat(outstandingTotal.totalOutstanding).toFixed(2)}</div>
                <div className="muted small text-xs text-gray-500">{outstandingTotal.count} customers owe money</div>
              </div>
            </div>
          )}
        </div>

        <div className="card pad p-4 bg-white rounded shadow" id="custStatement">
          {loadingStatement ? (
            <div className="p-4 text-gray-500">Loading statement…</div>
          ) : !statement || !selectedCustomer ? (
            <div className="state p-8 text-center text-gray-500">Select a customer to see the khata statement.</div>
          ) : (
            <div className="stack flex flex-col gap-4">
              <div className="row between flex justify-between items-start border-b pb-3">
                <div>
                  <div className="h2 text-xl font-bold" id="custStatementName">{selectedCustomer.name}</div>
                  <div className="muted small text-xs text-gray-500">{selectedCustomer.phone}</div>
                </div>
                <div>
                  {selectedCustomer.creditAllowed ? (
                    <span className="badge green bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded">Credit allowed</span>
                  ) : (
                    <span className="badge yellow bg-yellow-100 text-yellow-800 text-xs px-2 py-0.5 rounded">No credit</span>
                  )}{' '}
                  {!selectedCustomer.isActive && (
                    <span className="badge red bg-red-100 text-red-800 text-xs px-2 py-0.5 rounded">Inactive</span>
                  )}
                </div>
              </div>

              <div className="stats grid grid-cols-3 gap-3">
                <div className="stat-card p-3 bg-gray-50 rounded border">
                  <div className="stat-label text-xs text-gray-500">Outstanding</div>
                  <div className="stat-value font-mono text-lg font-bold text-red-600" id="custOutstanding">
                    ₹{parseFloat(statement.outstanding).toFixed(2)}
                  </div>
                </div>
                <div className="stat-card p-3 bg-gray-50 rounded border">
                  <div className="stat-label text-xs text-gray-500">Credit limit</div>
                  <div className="stat-value font-mono text-lg font-bold">
                    ₹{parseFloat(selectedCustomer.creditLimit).toFixed(2)}
                  </div>
                </div>
                <div className="stat-card p-3 bg-gray-50 rounded border">
                  <div className="stat-label text-xs text-gray-500">Remaining</div>
                  <div className={`stat-value font-mono text-lg font-bold ${remainingCredit < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                    ₹{remainingCredit.toFixed(2)}
                  </div>
                </div>
              </div>

              <form className="form-grid flex flex-col gap-3 p-3 bg-gray-50 rounded border" id="repayForm" onSubmit={handleRepayment}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="repayAmount">
                    Repayment (₹)
                    <input
                      id="repayAmount"
                      className="input p-2 border rounded"
                      inputMode="decimal"
                      required
                      value={repayAmount}
                      onChange={(e) => setRepayAmount(e.target.value)}
                    />
                  </label>
                  <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="repayMode">
                    Mode
                    <select
                      id="repayMode"
                      className="input p-2 border rounded"
                      value={repayMode}
                      onChange={(e) => setRepayMode(e.target.value)}
                    >
                      <option>CASH</option>
                      <option>UPI</option>
                      <option>CARD</option>
                    </select>
                  </label>
                </div>
                <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="repayNotes">
                  Notes
                  <input
                    id="repayNotes"
                    className="input p-2 border rounded"
                    maxLength={500}
                    value={repayNotes}
                    onChange={(e) => setRepayNotes(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="btn-primary px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium disabled:opacity-50"
                  id="repayBtn"
                  disabled={repaying || parseFloat(statement.outstanding) <= 0}
                >
                  {repaying ? 'Saving…' : 'Record repayment'}
                </button>
              </form>

              {isManager && (
                <details className="card p-3 bg-white rounded border">
                  <summary className="font-semibold text-sm cursor-pointer">Credit settings (manager)</summary>
                  <div className="pad pt-3">
                    <form className="form-grid flex flex-col gap-3" onSubmit={handleUpdateCredit}>
                      <label className="field flex flex-col gap-1 text-sm" htmlFor="ecLimit">
                        Credit limit (₹)
                        <input
                          id="ecLimit"
                          className="input p-2 border rounded"
                          inputMode="decimal"
                          value={ecLimit}
                          onChange={(e) => setEcLimit(e.target.value)}
                        />
                      </label>
                      <label className="check flex items-center gap-2 text-sm" htmlFor="ecAllow">
                        <input
                          id="ecAllow"
                          type="checkbox"
                          checked={ecAllow}
                          onChange={(e) => setEcAllow(e.target.checked)}
                        />
                        Allow credit
                      </label>
                      <label className="check flex items-center gap-2 text-sm" htmlFor="ecActive">
                        <input
                          id="ecActive"
                          type="checkbox"
                          checked={ecActive}
                          onChange={(e) => setEcActive(e.target.checked)}
                        />
                        Active
                      </label>
                      <button type="submit" className="btn-sec px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border">
                        Save
                      </button>
                    </form>
                  </div>
                </details>
              )}

              <div className="h2 text-lg font-bold">Khata ledger</div>
              {statement.entries.length > 0 ? (
                <div className="table-wrap overflow-x-auto">
                  <table className="table w-full text-left" id="custEntries">
                    <thead>
                      <tr className="border-b text-sm">
                        <th className="py-2">Date</th>
                        <th className="py-2">Type</th>
                        <th className="py-2 text-right">Amount</th>
                        <th className="py-2 text-right">Balance</th>
                        <th className="py-2">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.entries.map((t) => (
                        <tr key={t.id} className="border-b text-sm hover:bg-gray-50">
                          <td className="py-2 text-xs text-gray-600">
                            {new Date(t.recordedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                          </td>
                          <td className="py-2">
                            <span
                              className={`badge text-xs px-2 py-0.5 rounded ${
                                t.type === 'REPAYMENT'
                                  ? 'bg-green-100 text-green-800'
                                  : t.type === 'PURCHASE'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-blue-100 text-blue-800'
                              }`}
                            >
                              {t.type}
                            </span>{' '}
                            {t.paymentMode && <span className="muted small text-xs text-gray-500">{t.paymentMode}</span>}
                          </td>
                          <td className="py-2 text-right font-mono">₹{parseFloat(t.amount).toFixed(2)}</td>
                          <td className="py-2 text-right font-mono">₹{parseFloat(t.runningBalance).toFixed(2)}</td>
                          <td className="py-2 text-xs text-gray-600">{t.notes || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="state p-4 text-center text-gray-500">No transactions yet.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

