import { useAuth } from '../auth/AuthProvider';
import { Expenses } from './Expenses';

export function OutgoingExpenses() {
  const { user, activeBranchId } = useAuth();
  const branchId = activeBranchId ?? user?.branchId ?? '';
  return (
    <main className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Outgoing expenses</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300">Record payments and review the expense ledger by date, month, and year.</p>
      </div>
      {branchId && <Expenses branchId={branchId} />}
    </main>
  );
}
