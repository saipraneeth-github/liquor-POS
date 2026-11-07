import { api } from '../api/client';

// Receipts and kitchen tickets are sent to the branch's network printer (or local print agent) in the background
// after a sale. When a branch has neither, the server correctly answers 422, but firing that request on every
// sale only litters the console with errors. So ask once per branch whether auto-printing is set up at all.

interface BranchPrinterInfo { id: string; printerHost: string | null; printViaAgent?: boolean }

const cache = new Map<string, Promise<boolean>>();

export function hasAutoPrinter(branchId: string): Promise<boolean> {
  if (!branchId) return Promise.resolve(false);
  let hit = cache.get(branchId);
  if (!hit) {
    hit = api.get<BranchPrinterInfo[]>('/branches')
      .then((rows) => {
        const b = rows.find((r) => r.id === branchId);
        return !!b && (!!b.printerHost || !!b.printViaAgent);
      })
      .catch(() => {
        cache.delete(branchId);   // do not cache a failed lookup
        return true;              // unknown: keep the old best-effort behaviour
      });
    cache.set(branchId, hit);
  }
  return hit;
}

/** Call after printer settings change so the next sale re-checks. */
export function resetAutoPrinterCache(): void {
  cache.clear();
}

/** Best-effort print of a bill or KOT: silent when the branch has no printer configured. */
export async function autoPrint(branchId: string, kind: 'bills' | 'kot', id: string): Promise<void> {
  if (!(await hasAutoPrinter(branchId))) return;
  await api.post(`/print/${kind}/${id}/send?queue=true`).catch(() => { /* the Print button still works */ });
}
