import { z } from 'zod';
import { db } from '../../db/client.js';
import { syndicates, branches, bills, consolidatedInvoices } from '../../db/schema.js';
import { and, desc, eq, gte, inArray, lt, lte, ne, or, isNull } from 'drizzle-orm';
import { aggregateConsolidatedInvoice, assertValidPeriod } from './consolidation.engine.js';
import { businessRangeBounds, isIsoDate } from '../../lib/business-day.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const GSTIN = z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 alphanumeric characters');
const PAN = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN');

export const CreateSyndicateSchema = z.object({
  name:         z.string().trim().min(1).max(200),
  gstin:        GSTIN.optional(),
  pan:          PAN.optional(),
  contactPhone: z.string().trim().min(6).max(20).optional(),
});

export const UpdateSyndicateSchema = CreateSyndicateSchema.partial().extend({
  isActive: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field is required');

export const ConsolidatedInvoiceSchema = z.object({
  periodStart: z.string().refine(isIsoDate, 'periodStart must be YYYY-MM-DD'),
  periodEnd:   z.string().refine(isIsoDate, 'periodEnd must be YYYY-MM-DD'),
});

export type CreateSyndicateInput = z.infer<typeof CreateSyndicateSchema>;
export type UpdateSyndicateInput = z.infer<typeof UpdateSyndicateSchema>;

// ─── SYNDICATES ─────────────────────────────────────────────────────────────

/** `scope === 'ALL'` → every syndicate; otherwise only the given syndicate id. */
export async function listSyndicates(scope: 'ALL' | string) {
  if (scope === 'ALL') return db.select().from(syndicates).orderBy(syndicates.name);
  return db.select().from(syndicates).where(eq(syndicates.id, scope));
}

export async function getSyndicate(id: string) {
  const [row] = await db.select().from(syndicates).where(eq(syndicates.id, id)).limit(1);
  return row ?? null;
}

export async function createSyndicate(data: CreateSyndicateInput) {
  const [row] = await db.insert(syndicates).values(data).returning();
  return row;
}

export async function updateSyndicate(id: string, data: UpdateSyndicateInput) {
  const [row] = await db.update(syndicates).set(data).where(eq(syndicates.id, id)).returning();
  if (!row) throw new NotFoundError('Syndicate not found');
  return row;
}

/** All branches of a syndicate. */
export async function getSyndicateBranches(syndicateId: string) {
  return db
    .select()
    .from(branches)
    .where(eq(branches.syndicateId, syndicateId))
    .orderBy(branches.code);
}

/** Moves a branch into a syndicate. */
export async function assignBranchToSyndicate(syndicateId: string, branchId: string) {
  const syndicate = await getSyndicate(syndicateId);
  if (!syndicate) throw new NotFoundError('Syndicate not found');
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(branches).where(eq(branches.id, branchId)).for('update');
    if (!existing) throw new NotFoundError('Branch not found');
    if (existing.syndicateId === syndicateId) return existing;

    // A parent must belong to the same syndicate: detach links that would now cross syndicates
    const [row] = await tx
      .update(branches)
      .set({ syndicateId, parentBranchId: null })
      .where(eq(branches.id, branchId))
      .returning();
    await tx
      .update(branches)
      .set({ parentBranchId: null })
      .where(and(
        eq(branches.parentBranchId, branchId),
        or(isNull(branches.syndicateId), ne(branches.syndicateId, syndicateId)),
      ));
    return row;
  });
}

// ─── CONSOLIDATED INVOICES ──────────────────────────────────────────────────

/**
 * Aggregates PAID bills across the syndicate's branches for the inclusive date range
 * and stores the snapshot in consolidated_invoices.
 */
export async function createConsolidatedInvoice(
  syndicateId: string,
  periodStart: string,
  periodEnd: string,
  createdById: string,
) {
  try {
    assertValidPeriod(periodStart, periodEnd);
  } catch (err) {
    throw new BusinessRuleError(err instanceof Error ? err.message : 'Invalid period');
  }

  return db.transaction(async (tx) => {
    // Lock the syndicate row: serialises invoice creation so overlap checks cannot race
    const [syndicate] = await tx.select({ id: syndicates.id }).from(syndicates).where(eq(syndicates.id, syndicateId)).for('update');
    if (!syndicate) throw new NotFoundError('Syndicate not found');

    // Overlapping periods would bill the same sales twice
    const [overlap] = await tx
      .select({ id: consolidatedInvoices.id, periodStart: consolidatedInvoices.periodStart, periodEnd: consolidatedInvoices.periodEnd })
      .from(consolidatedInvoices)
      .where(and(
        eq(consolidatedInvoices.syndicateId, syndicateId),
        lte(consolidatedInvoices.periodStart, periodEnd),
        gte(consolidatedInvoices.periodEnd, periodStart),
      ))
      .limit(1);
    if (overlap) {
      throw new ConflictError(`Period overlaps consolidated invoice ${overlap.periodStart}..${overlap.periodEnd}`);
    }

    const branchRows = await tx
      .select({ id: branches.id, name: branches.name, code: branches.code })
      .from(branches)
      .where(eq(branches.syndicateId, syndicateId));

    const { start, end } = businessRangeBounds(periodStart, periodEnd);
    const billRows = branchRows.length === 0 ? [] : await tx
      .select({ branchId: bills.branchId, total: bills.total, taxAmount: bills.taxAmount, status: bills.status })
      .from(bills)
      .where(and(
        inArray(bills.branchId, branchRows.map((b) => b.id)),
        eq(bills.status, 'PAID'),
        gte(bills.createdAt, start),
        lt(bills.createdAt, end),
      ));

    const totals = aggregateConsolidatedInvoice(branchRows, billRows);

    const [row] = await tx.insert(consolidatedInvoices).values({
      syndicateId,
      periodStart,
      periodEnd,
      grossSales: totals.grossSales,
      totalTax:   totals.totalTax,
      billCount:  totals.billCount,
      breakdown:  totals.breakdown,
      createdById,
    }).returning();
    return row;
  });
}

export async function listConsolidatedInvoices(syndicateId: string) {
  return db
    .select()
    .from(consolidatedInvoices)
    .where(eq(consolidatedInvoices.syndicateId, syndicateId))
    .orderBy(desc(consolidatedInvoices.createdAt));
}
