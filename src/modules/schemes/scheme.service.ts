/**
 * scheme.service.ts — DB-backed supplier scheme operations.
 */

import { db } from '../../db/client.js';
import { schemes, schemePurchases, schemeSlabs } from '../../db/schema.js';
import { asc, eq, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import {
  computeSchemeProgress,
  isSchemeAlertTriggered,
  type Scheme,
} from './scheme.engine.js';
import { evaluateSlabs, validateSlabs } from './slab.engine.js';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function rowToScheme(row: typeof schemes.$inferSelect): Scheme {
  return {
    id:                row.id,
    supplierName:      row.supplierName,
    branchId:          row.branchId,
    targetType:        row.targetType,
    targetValue:       new Decimal(row.targetValue),
    currentValue:      new Decimal(row.currentValue),
    rewardDescription: row.rewardDescription,
    startDate:         row.startDate!,
    endDate:           row.endDate!,
    alertThresholdPct: row.alertThresholdPct ? Number(row.alertThresholdPct) : 80,
  };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export async function getSchemesForBranch(branchId: string) {
  const rows = await db
    .select()
    .from(schemes)
    .where(eq(schemes.branchId, branchId));

  return rows.map((row) => ({
    ...row,
    progressPct: computeSchemeProgress(rowToScheme(row)).toNumber(),
    alertActive: isSchemeAlertTriggered(rowToScheme(row)),
  }));
}

// ─── ALERTS ──────────────────────────────────────────────────────────────────

export async function getSchemeAlerts(branchId: string) {
  const all = await getSchemesForBranch(branchId);
  return all.filter((s) => s.alertActive && s.status === 'ACTIVE');
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

export interface CreateSchemeInput {
  branchId: string;
  supplierName: string;
  schemeName: string;
  targetType: 'VALUE' | 'QTY';
  targetValue: string;
  rewardDescription: string;
  startDate: string;
  endDate: string;
  alertThresholdPct?: string;
  notes?: string;
}

export async function createScheme(input: CreateSchemeInput) {
  const [scheme] = await db
    .insert(schemes)
    .values({
      branchId:          input.branchId,
      supplierName:      input.supplierName,
      schemeName:        input.schemeName,
      targetType:        input.targetType,
      targetValue:       input.targetValue,
      rewardDescription: input.rewardDescription,
      startDate:         new Date(input.startDate),
      endDate:           new Date(input.endDate),
      alertThresholdPct: input.alertThresholdPct ?? '80.00',
      notes:             input.notes ?? null,
    })
    .returning();
  return scheme;
}

// ─── RECORD PURCHASE AGAINST SCHEME ──────────────────────────────────────────

export async function getSchemeById(schemeId: string) {
  const [scheme] = await db.select().from(schemes).where(eq(schemes.id, schemeId)).limit(1);
  return scheme ?? null;
}

export async function recordSchemePurchase(
  schemeId: string,
  qty: string,
  value: string,
  referenceId?: string,
  notes?: string
) {
  return db.transaction(async (tx) => {
    const [scheme] = await tx
      .select({ targetType: schemes.targetType, status: schemes.status })
      .from(schemes)
      .where(eq(schemes.id, schemeId));

    if (!scheme) throw new NotFoundError(`Scheme ${schemeId} not found.`);
    if (scheme.status !== 'ACTIVE') throw new BusinessRuleError(`Scheme is ${scheme.status}; purchases can only be recorded on ACTIVE schemes.`);

    const increment = scheme.targetType === 'QTY' ? new Decimal(qty) : new Decimal(value);
    if (increment.isNegative() || increment.isZero()) {
      throw new BusinessRuleError(`A positive ${scheme.targetType === 'QTY' ? 'qty' : 'value'} is required for this scheme.`);
    }

    const [purchase] = await tx
      .insert(schemePurchases)
      .values({
        schemeId,
        qty: new Decimal(qty).toFixed(2),
        value: new Decimal(value).toFixed(2),
        referenceId: referenceId ?? null,
        notes: notes ?? null,
      })
      .returning();

    // Atomic increment (no read-then-write race)
    await tx
      .update(schemes)
      .set({ currentValue: sql`${schemes.currentValue} + ${increment.toFixed(2)}` })
      .where(eq(schemes.id, schemeId));

    return purchase;
  });
}

// ─── SLABS ───────────────────────────────────────────────────────────────────

export interface SlabInput {
  minCases: number;
  freeBottles: number;
  discountPerCase: string;
}

export async function getSchemeSlabs(schemeId: string) {
  return db.select().from(schemeSlabs)
    .where(eq(schemeSlabs.schemeId, schemeId))
    .orderBy(asc(schemeSlabs.minCases));
}

/** Replaces all slabs of a scheme atomically. */
export async function replaceSchemeSlabs(schemeId: string, slabs: SlabInput[]) {
  const problem = validateSlabs(slabs);
  if (problem) throw new BusinessRuleError(problem);

  return db.transaction(async (tx) => {
    const [scheme] = await tx.select({ id: schemes.id }).from(schemes).where(eq(schemes.id, schemeId)).for('update');
    if (!scheme) throw new NotFoundError(`Scheme ${schemeId} not found.`);

    await tx.delete(schemeSlabs).where(eq(schemeSlabs.schemeId, schemeId));
    if (slabs.length === 0) return [];

    const rows = await tx.insert(schemeSlabs).values(
      slabs.map((s) => ({
        schemeId,
        minCases:        s.minCases,
        freeBottles:     s.freeBottles,
        discountPerCase: new Decimal(s.discountPerCase).toFixed(2),
      })),
    ).returning();
    return rows.sort((a, b) => a.minCases - b.minCases);
  });
}

/**
 * Evaluates the scheme's recorded purchases against its slabs.
 * `scheme_purchases.qty` is interpreted as CASES (the unit used by QTY schemes).
 */
export async function getSchemePayout(scheme: typeof schemes.$inferSelect) {
  const [{ totalCases, purchaseCount, totalValue }] = await db
    .select({
      totalCases:    sql<string>`coalesce(sum(${schemePurchases.qty}), 0)::text`,
      totalValue:    sql<string>`coalesce(sum(${schemePurchases.value}), 0)::text`,
      purchaseCount: sql<number>`count(*)::int`,
    })
    .from(schemePurchases)
    .where(eq(schemePurchases.schemeId, scheme.id));

  const slabs = await getSchemeSlabs(scheme.id);
  const evaluation = evaluateSlabs(totalCases, slabs);

  return {
    schemeId:      scheme.id,
    schemeName:    scheme.schemeName,
    targetType:    scheme.targetType,
    purchaseCount: Number(purchaseCount),
    totalValue:    new Decimal(totalValue).toFixed(2),
    slabs,
    ...evaluation,
  };
}
