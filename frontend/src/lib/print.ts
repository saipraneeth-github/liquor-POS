import { api } from '../api/client';

/** api.* throws the raw response text; pull the `error` field out when it is JSON. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    return parsed.error || parsed.message || raw;
  } catch {
    return raw;
  }
}

export function showToast(msg: string, type: 'success' | 'error' | 'info' = 'success') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type} ${
    type === 'error' ? 'bg-red-600' : type === 'info' ? 'bg-blue-600' : 'bg-emerald-600'
  } text-white p-3 rounded-lg shadow-lg font-medium text-sm mb-2`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

export type PrintKind = 'bills' | 'kot';

/** Browser print: fetches the HTML receipt / ticket and prints it from a popup (works with any OS printer). */
export async function printInBrowser(kind: PrintKind, id: string): Promise<void> {
  // Open synchronously from the click so popup blockers allow it
  const win = window.open('', '_blank', 'width=420,height=640');
  if (!win) {
    showToast('Allow pop-ups to print.', 'error');
    return;
  }
  try {
    const res = await fetch(`/api/v1/print/${kind}/${id}?format=html`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    if (!res.ok) throw new Error(await res.text());
    win.document.open();
    win.document.write(await res.text());
    win.document.close();
    win.focus();
    win.print();
  } catch (err) {
    win.close();
    showToast('Could not print: ' + errorMessage(err), 'error');
  }
}

/** Sends the document to the branch's configured network (ESC/POS) printer. */
export async function sendToNetworkPrinter(kind: PrintKind, id: string): Promise<boolean> {
  try {
    await api.post(`/print/${kind}/${id}/send`);
    showToast('Sent to printer.', 'success');
    return true;
  } catch (err) {
    showToast(errorMessage(err), 'error');
    return false;
  }
}
