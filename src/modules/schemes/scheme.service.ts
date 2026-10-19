/**
 * scheme.service.ts — DB-backed supplier scheme operations.
 */

import { db } from '../../db/client';
import { schemes, schemePurchases } from '../../db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import {
  computeSchemeProgress,
  isSchemeAlertTriggered,
  type Scheme,
} from './scheme.engine';

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

export async function recordSchemePurchase(
  schemeId: string,
  qty: string,
  value: string,
  referenceId?: string,
  notes?: string
) {
  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .insert(schemePurchases)
      .values({ schemeId, qty, value, referenceId: referenceId ?? null, notes: notes ?? null })
      .returning();

    // Increment currentValue on the scheme
    const [scheme] = await tx
      .select({ currentValue: schemes.currentValue, targetType: schemes.targetType })
      .from(schemes)
      .where(eq(schemes.id, schemeId));

    if (!scheme) throw new Error(`Scheme ${schemeId} not found.`);

    const increment = scheme.targetType === 'QTY' ? new Decimal(qty) : new Decimal(value);
    const newCurrent = new Decimal(scheme.currentValue).plus(increment);

    await tx
      .update(schemes)
      .set({ currentValue: newCurrent.toFixed(2) })
      .where(eq(schemes.id, schemeId));

    return purchase;
  });
}
