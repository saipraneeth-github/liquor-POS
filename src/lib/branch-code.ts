import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { branches } from '../db/schema.js';
import { NotFoundError } from './errors.js';

/**
 * A branch's code never changes (it is baked into every bill and voucher number), so once read it is kept for the life of the
 * process. Billing and posting ask for it on every sale; on a hosted database each of those lookups was a network round trip.
 */
const codes = new Map<string, string>();

export async function branchCodeOf(exec: Pick<typeof db, 'select'>, branchId: string): Promise<string> {
  const hit = codes.get(branchId);
  if (hit) return hit;
  const [branch] = await exec.select({ code: branches.code }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new NotFoundError('Branch not found');
  codes.set(branchId, branch.code);
  return branch.code;
}
