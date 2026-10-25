import { z } from 'zod';
import { db } from '../../db/client.js';
import { branches, syndicates } from '../../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import type { JwtPayload } from '../auth/auth.service.js';
import { canAccessBranch, getAccessibleBranchIds, getOwnedSyndicateId, isPlatformOwner } from '../../middleware/auth.guard.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const GSTIN = z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 alphanumeric characters');

export const CreateBranchSchema = z.object({
  name:            z.string().trim().min(1).max(200),
  code:            z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, 'code must be 2-10 letters/digits'),
  address:         z.string().trim().max(500).optional(),
  gstin:           GSTIN.optional(),
  exciseLicenseNo: z.string().trim().max(100).optional(),
  parentBranchId:  z.string().uuid().optional(),
  syndicateId:     z.string().uuid().optional(),   // platform owner only
});

// code is immutable: it is baked into every issued bill number
export const UpdateBranchSchema = z.object({
  name:            z.string().trim().min(1).max(200).optional(),
  address:         z.string().trim().max(500).nullable().optional(),
  gstin:           GSTIN.nullable().optional(),
  exciseLicenseNo: z.string().trim().max(100).nullable().optional(),
  parentBranchId:  z.string().uuid().nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field is required');

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;

// ─── HELPERS ────────────────────────────────────────────────────────────────

/** Platform or syndicate owner — the only roles that manage branch master data. */
async function assertBranchAdmin(user: JwtPayload): Promise<{ platform: boolean; syndicateId: string | null }> {
  if (user.role !== 'owner') throw new ForbiddenError('Forbidden: owner only');
  if (await isPlatformOwner(user)) return { platform: true, syndicateId: null };
  const own = await getOwnedSyndicateId(user);
  if (!own) throw new ForbiddenError('Forbidden: platform or syndicate owner only');
  return { platform: false, syndicateId: own };
}

async function assertValidParent(user: JwtPayload, parentBranchId: string, syndicateId: string | null, selfId?: string) {
  if (parentBranchId === selfId) throw new BusinessRuleError('A branch cannot be its own parent');
  const [parent] = await db.select().from(branches).where(eq(branches.id, parentBranchId)).limit(1);
  if (!parent || !(await canAccessBranch(user, parentBranchId))) throw new BusinessRuleError('Parent branch not found');
  if ((parent.syndicateId ?? null) !== syndicateId) throw new BusinessRuleError('Parent branch must belong to the same syndicate');

  // Walk up from the proposed parent; reaching `selfId` means the change would create a cycle
  if (selfId) {
    const seen = new Set<string>();
    let cursor: string | null = parent.parentBranchId ?? null;
    while (cursor && !seen.has(cursor)) {
      if (cursor === selfId) throw new BusinessRuleError('Parent assignment would create a branch hierarchy cycle');
      seen.add(cursor);
      const [next] = await db.select({ parentBranchId: branches.parentBranchId }).from(branches).where(eq(branches.id, cursor)).limit(1);
      cursor = next?.parentBranchId ?? null;
    }
  }
}

// ─── QUERIES ────────────────────────────────────────────────────────────────

export async function listBranches(user: JwtPayload) {
  const scope = await getAccessibleBranchIds(user);
  if (scope === 'ALL') return db.select().from(branches).orderBy(branches.code);
  if (scope.length === 0) return [];
  return db.select().from(branches).where(inArray(branches.id, scope)).orderBy(branches.code);
}

export async function createBranch(user: JwtPayload, input: CreateBranchInput) {
  const admin = await assertBranchAdmin(user);

  let syndicateId: string | null;
  if (admin.platform) {
    syndicateId = input.syndicateId ?? null;
    if (syndicateId) {
      const [s] = await db.select({ id: syndicates.id }).from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
      if (!s) throw new BusinessRuleError('Syndicate not found');
    }
  } else {
    if (input.syndicateId && input.syndicateId !== admin.syndicateId) {
      throw new ForbiddenError('Cannot create branches in another syndicate');
    }
    syndicateId = admin.syndicateId;
  }

  if (input.parentBranchId) await assertValidParent(user, input.parentBranchId, syndicateId);

  try {
    const [row] = await db.insert(branches).values({
      name: input.name,
      code: input.code,
      address: input.address,
      gstin: input.gstin,
      exciseLicenseNo: input.exciseLicenseNo,
      parentBranchId: input.parentBranchId ?? null,
      syndicateId,
    }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`Branch code ${input.code} already exists`);
    throw err;
  }
}

export async function updateBranch(user: JwtPayload, branchId: string, patch: UpdateBranchInput) {
  await assertBranchAdmin(user);
  const [existing] = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!existing || !(await canAccessBranch(user, branchId))) throw new NotFoundError('Branch not found');

  if (patch.parentBranchId) await assertValidParent(user, patch.parentBranchId, existing.syndicateId ?? null, branchId);

  const [row] = await db.update(branches).set(patch).where(eq(branches.id, branchId)).returning();
  return row;
}
