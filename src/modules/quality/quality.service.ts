/**
 * quality.service.ts — persistence for the flaw tracker.
 *
 * Every entry point resolves the caller's tenant and then runs inside `withTenant(...)`, which sets
 * the `app.tenant_id` that the Row-Level Security policies check. Queries also filter by tenant
 * explicitly: RLS is the backstop, not the plan.
 *
 * Duplicate handling follows a suggest-only rule: the exact fingerprint blocks a second copy, fuzzy
 * matches are RETURNED as suggestions, and only a human can link or merge.
 */

import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { withTenant } from '../../db/tenant-rls.js';
import {
  flawAttachments, flawComments, flawCounters, flawDuplicates, flawHistory, flawLinks,
  flawTagMap, flawTags, flaws, qualityModules, users,
} from '../../db/schema.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { businessDateOf } from '../../lib/business-day.js';
import type { JwtPayload } from '../auth/auth.service.js';
import type { Tx } from '../../lib/domain-events.js';
import { tenantOf } from '../menu/menu-access.js';
import {
  assertTransition, flawFingerprint, nextFlawReference, normalizeTitle, suggestDuplicates,
  type DuplicateSuggestion, type FlawStatus,
} from './quality.engine.js';

// ─── SCHEMAS ─────────────────────────────────────────────────────────────────

export const FLAW_SEVERITY_VALUES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL'] as const;
export const FLAW_STATUS_VALUES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'CLOSED', 'REOPENED', 'DUPLICATE', 'REJECTED', 'DEFERRED'] as const;

const TagList = z.array(z.string().trim().min(1).max(30)).max(10);

export const CreateFlawSchema = z.object({
  title:           z.string().trim().min(5, 'Title must be at least 5 characters').max(200),
  description:     z.string().trim().max(10_000).optional(),
  severity:        z.enum(FLAW_SEVERITY_VALUES).default('MINOR'),
  priority:        z.number().int().min(1).max(5).default(3),
  moduleId:        z.string().uuid().optional(),
  environment:     z.enum(['DEV', 'QA', 'STAGING', 'PROD']).optional(),
  affectedVersion: z.string().trim().max(40).optional(),
  assigneeId:      z.string().uuid().optional(),
  tags:            TagList.optional(),
});

export const UpdateFlawSchema = z.object({
  title:           z.string().trim().min(5).max(200).optional(),
  description:     z.string().trim().max(10_000).nullable().optional(),
  severity:        z.enum(FLAW_SEVERITY_VALUES).optional(),
  priority:        z.number().int().min(1).max(5).optional(),
  moduleId:        z.string().uuid().nullable().optional(),
  environment:     z.enum(['DEV', 'QA', 'STAGING', 'PROD']).nullable().optional(),
  affectedVersion: z.string().trim().max(40).nullable().optional(),
  fixedVersion:    z.string().trim().max(40).nullable().optional(),
  assigneeId:      z.string().uuid().nullable().optional(),
  tags:            TagList.optional(),
});

export const StatusSchema = z.object({
  status: z.enum(FLAW_STATUS_VALUES),
  comment: z.string().trim().max(2_000).optional(),
});

export const LinkDuplicateSchema = z.object({
  canonicalId: z.string().uuid(),
  note:        z.string().trim().max(500).optional(),
});

export const ListFlawsQuerySchema = z.object({
  status:    z.enum(FLAW_STATUS_VALUES).optional(),
  severity:  z.enum(FLAW_SEVERITY_VALUES).optional(),
  moduleId:  z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  q:         z.string().trim().max(200).optional(),
  limit:     z.coerce.number().int().min(1).max(200).default(50),
  offset:    z.coerce.number().int().min(0).default(0),
});

export const CreateModuleSchema = z.object({
  key:         z.string().trim().min(2).max(40).regex(/^[a-z0-9._-]+$/, 'Use lower-case letters, digits, dots, dashes or underscores'),
  name:        z.string().trim().min(2).max(120),
  parentId:    z.string().uuid().optional(),
  description: z.string().trim().max(500).optional(),
  ownerId:     z.string().uuid().optional(),
});

export type CreateFlawInput = z.infer<typeof CreateFlawSchema>;
export type UpdateFlawInput = z.infer<typeof UpdateFlawSchema>;
export type ListFlawsQuery = z.infer<typeof ListFlawsQuerySchema>;

// ─── TENANT ──────────────────────────────────────────────────────────────────

/**
 * The business this call belongs to. A platform owner must name the tenant explicitly; everyone
 * else is pinned to their own business, whatever the request body says.
 */
async function resolveTenantId(user: JwtPayload, requestedTenantId?: string | null): Promise<string> {
  const tenant = await tenantOf(user);
  if (tenant === 'ALL') {
    if (!requestedTenantId) throw new ForbiddenError('Platform accounts must name the tenant (tenantId)');
    return requestedTenantId;
  }
  if (!tenant) throw new ForbiddenError('No business is linked to this account');
  if (requestedTenantId && requestedTenantId !== tenant) {
    throw new ForbiddenError('Cannot work with another business');
  }
  return tenant;
}

async function assertSameTenant(tx: Tx, tenantId: string, table: 'module' | 'user', id: string): Promise<void> {
  if (table === 'module') {
    const [row] = await tx.select({ id: qualityModules.id }).from(qualityModules)
      .where(and(eq(qualityModules.id, id), eq(qualityModules.tenantId, tenantId))).limit(1);
    if (!row) throw new BusinessRuleError('Module not found in this business');
    return;
  }
  const [row] = await tx.select({ id: users.id }).from(users)
    .where(and(eq(users.id, id), eq(users.syndicateId, tenantId))).limit(1);
  if (!row) throw new BusinessRuleError('Assignee not found in this business');
}

// ─── REFERENCE NUMBERS ───────────────────────────────────────────────────────

/** FLW-<year>-000123, atomic per tenant per year (mirrors billing's bill_counters). */
async function nextReference(tx: Tx, tenantId: string): Promise<string> {
  const year = Number(businessDateOf().slice(0, 4));
  const [counter] = await tx
    .insert(flawCounters)
    .values({ tenantId, year, lastSeq: 1 })
    .onConflictDoUpdate({
      target: [flawCounters.tenantId, flawCounters.year],
      set: { lastSeq: sql`${flawCounters.lastSeq} + 1` },
    })
    .returning({ lastSeq: flawCounters.lastSeq });
  return nextFlawReference(year, counter.lastSeq);
}

async function record(tx: Tx, tenantId: string, flawId: string, userId: string | null, action: string, field?: string, before?: unknown, after?: unknown): Promise<void> {
  await tx.insert(flawHistory).values({
    tenantId,
    flawId,
    changedById: userId,
    action,
    fieldName: field ?? null,
    oldValue: (before ?? null) as never,
    newValue: (after ?? null) as never,
  });
}

async function setTags(tx: Tx, tenantId: string, flawId: string, names: string[]): Promise<void> {
  await tx.delete(flawTagMap).where(eq(flawTagMap.flawId, flawId));
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const [tag] = await tx.insert(flawTags)
      .values({ tenantId, name })
      .onConflictDoUpdate({ target: [flawTags.tenantId, flawTags.name], set: { name } })
      .returning({ id: flawTags.id });
    await tx.insert(flawTagMap).values({ flawId, tagId: tag.id }).onConflictDoNothing();
  }
}

async function tagsOf(tx: Tx, flawId: string) {
  return tx.select({ name: flawTags.name, color: flawTags.color })
    .from(flawTagMap)
    .innerJoin(flawTags, eq(flawTags.id, flawTagMap.tagId))
    .where(eq(flawTagMap.flawId, flawId));
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export interface CreateFlawResult {
  flaw: typeof flaws.$inferSelect & { tags: { name: string; color: string | null }[] };
  /** Fuzzy candidates, best first. Informational: nothing was linked. */
  suggestions: DuplicateSuggestion[];
}

/**
 * Creates a flaw. Two duplicate layers run here:
 *   1. exact — the fingerprint (tenant + module + normalised title + version) already exists → 409;
 *   2. fuzzy — similar open flaws are returned as `suggestions` and never applied.
 */
export async function createFlaw(input: CreateFlawInput, user: JwtPayload, requestedTenantId?: string | null): Promise<CreateFlawResult> {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  const titleKey = normalizeTitle(input.title);
  const fingerprint = flawFingerprint(tenantId, input.moduleId ?? null, input.title, input.affectedVersion);

  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx.select({ id: flaws.id, reference: flaws.reference })
      .from(flaws)
      .where(and(eq(flaws.tenantId, tenantId), eq(flaws.fingerprint, fingerprint)))
      .limit(1);
    if (existing) {
      throw new ConflictError(`This flaw already exists as ${existing.reference}`, { id: existing.id, reference: existing.reference });
    }

    if (input.moduleId) await assertSameTenant(tx, tenantId, 'module', input.moduleId);
    if (input.assigneeId) await assertSameTenant(tx, tenantId, 'user', input.assigneeId);

    const reference = await nextReference(tx, tenantId);

    // Fuzzy candidates: open flaws in the same module (or every module), newest first, capped.
    const candidates = await tx.select({
      id: flaws.id, reference: flaws.reference, title: flaws.title, status: flaws.status,
      moduleId: flaws.moduleId, duplicateOfId: flaws.duplicateOfId,
    }).from(flaws)
      .where(and(
        eq(flaws.tenantId, tenantId),
        input.moduleId ? eq(flaws.moduleId, input.moduleId) : undefined,
        or(isNull(flaws.status), sql`${flaws.status} not in ('CLOSED','REJECTED')`),
      ))
      .orderBy(desc(flaws.createdAt))
      .limit(200);
    const suggestions = suggestDuplicates({ title: input.title, moduleId: input.moduleId ?? null }, candidates);

    const [flaw] = await tx.insert(flaws).values({
      tenantId,
      reference,
      title: input.title.trim(),
      titleKey,
      fingerprint,
      description: input.description ?? null,
      severity: input.severity,
      priority: input.priority,
      status: 'NEW',
      moduleId: input.moduleId ?? null,
      environment: input.environment ?? null,
      affectedVersion: input.affectedVersion ?? null,
      reporterId: user.sub,
      assigneeId: input.assigneeId ?? null,
    }).returning();

    await record(tx, tenantId, flaw.id, user.sub, 'CREATED', undefined, undefined, { reference, title: flaw.title, severity: flaw.severity });
    if (input.tags?.length) await setTags(tx, tenantId, flaw.id, input.tags);

    return { flaw: { ...flaw, tags: await tagsOf(tx, flaw.id) }, suggestions };
  });
}

// ─── READ ────────────────────────────────────────────────────────────────────

export async function listFlaws(query: ListFlawsQuery, user: JwtPayload, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    const conds = [eq(flaws.tenantId, tenantId)];
    if (query.status) conds.push(eq(flaws.status, query.status as FlawStatus));
    if (query.severity) conds.push(eq(flaws.severity, query.severity));
    if (query.moduleId) conds.push(eq(flaws.moduleId, query.moduleId));
    if (query.assigneeId) conds.push(eq(flaws.assigneeId, query.assigneeId));
    if (query.q) {
      // Strip LIKE wildcards so a user cannot force a full scan or inject a pattern.
      conds.push(ilike(flaws.title, `%${query.q.replace(/[%_\\]/g, '')}%`));
    }
    const where = and(...conds);
    const [rows, [{ count }]] = await Promise.all([
      tx.select().from(flaws).where(where).orderBy(desc(flaws.createdAt)).limit(query.limit).offset(query.offset),
      tx.select({ count: sql<number>`count(*)::int` }).from(flaws).where(where),
    ]);
    return { flaws: rows, total: Number(count), limit: query.limit, offset: query.offset };
  });
}

export async function getFlaw(id: string, user: JwtPayload, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    const [flaw] = await tx.select().from(flaws).where(and(eq(flaws.id, id), eq(flaws.tenantId, tenantId))).limit(1);
    if (!flaw) throw new NotFoundError('Flaw not found');

    const [tags, comments, trail, dupes] = await Promise.all([
      tagsOf(tx, id),
      tx.select({
        id: flawComments.id, body: flawComments.body, isInternal: flawComments.isInternal,
        authorId: flawComments.authorId, createdAt: flawComments.createdAt,
      }).from(flawComments).where(eq(flawComments.flawId, id)).orderBy(asc(flawComments.createdAt)),
      tx.select({
        id: flawHistory.id, action: flawHistory.action, fieldName: flawHistory.fieldName,
        oldValue: flawHistory.oldValue, newValue: flawHistory.newValue,
        changedById: flawHistory.changedById, createdAt: flawHistory.createdAt,
      }).from(flawHistory).where(eq(flawHistory.flawId, id)).orderBy(desc(flawHistory.createdAt)).limit(200),
      tx.select({ id: flaws.id, reference: flaws.reference, title: flaws.title })
        .from(flawDuplicates)
        .innerJoin(flaws, eq(flaws.id, flawDuplicates.duplicateId))
        .where(eq(flawDuplicates.canonicalId, id)),
    ]);

    return { ...flaw, tags, comments, history: trail, duplicates: dupes };
  });
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────

export async function updateFlaw(id: string, input: UpdateFlawInput, user: JwtPayload, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    const [current] = await tx.select().from(flaws)
      .where(and(eq(flaws.id, id), eq(flaws.tenantId, tenantId)))
      .for('update');
    if (!current) throw new NotFoundError('Flaw not found');

    if (input.moduleId) await assertSameTenant(tx, tenantId, 'module', input.moduleId);
    if (input.assigneeId) await assertSameTenant(tx, tenantId, 'user', input.assigneeId);

    const moduleId = input.moduleId === undefined ? current.moduleId : input.moduleId;
    const title = input.title === undefined ? current.title : input.title.trim();
    const affectedVersion = input.affectedVersion === undefined ? current.affectedVersion : input.affectedVersion;

    const patch: Partial<typeof flaws.$inferInsert> = { updatedAt: new Date() };
    const changed: string[] = [];

    if (title !== current.title) { patch.title = title; changed.push('title'); }
    if (moduleId !== current.moduleId) { patch.moduleId = moduleId; changed.push('moduleId'); }
    if (affectedVersion !== current.affectedVersion) { patch.affectedVersion = affectedVersion; changed.push('affectedVersion'); }
    if (input.description !== undefined && input.description !== current.description) { patch.description = input.description; changed.push('description'); }
    if (input.severity !== undefined && input.severity !== current.severity) { patch.severity = input.severity; changed.push('severity'); }
    if (input.priority !== undefined && input.priority !== current.priority) { patch.priority = input.priority; changed.push('priority'); }
    if (input.environment !== undefined && input.environment !== current.environment) { patch.environment = input.environment; changed.push('environment'); }
    if (input.fixedVersion !== undefined && input.fixedVersion !== current.fixedVersion) { patch.fixedVersion = input.fixedVersion; changed.push('fixedVersion'); }
    if (input.assigneeId !== undefined && input.assigneeId !== current.assigneeId) { patch.assigneeId = input.assigneeId; changed.push('assigneeId'); }

    // A new identity (title/module/version) must be re-fingerprinted or the exact-duplicate
    // guarantee would silently stop working.
    if (changed.includes('title') || changed.includes('moduleId') || changed.includes('affectedVersion')) {
      patch.titleKey = normalizeTitle(title);
      patch.fingerprint = flawFingerprint(tenantId, moduleId, title, affectedVersion);
    }

    if (input.tags) await setTags(tx, tenantId, id, input.tags);

    if (changed.length === 0) {
      const [row] = await tx.select().from(flaws).where(eq(flaws.id, id)).limit(1);
      return { ...row, tags: await tagsOf(tx, id) };
    }

    let updated: typeof flaws.$inferSelect;
    try {
      [updated] = await tx.update(flaws).set(patch).where(eq(flaws.id, id)).returning();
    } catch (err) {
      // Another flaw now owns this identity (same tenant + module + title + version).
      if (isUniqueViolation(err)) {
        const [clash] = await tx.select({ reference: flaws.reference }).from(flaws)
          .where(and(eq(flaws.tenantId, tenantId), eq(flaws.fingerprint, patch.fingerprint!))).limit(1);
        throw new ConflictError(clash ? `This flaw already exists as ${clash.reference}` : 'Duplicate record');
      }
      throw err;
    }

    for (const field of changed) {
      const key = field as keyof typeof current;
      await record(tx, tenantId, id, user.sub, 'FIELD_CHANGED', field, current[key], updated[key]);
    }
    if (changed.includes('assigneeId')) {
      await record(tx, tenantId, id, user.sub, 'ASSIGNED', 'assigneeId', current.assigneeId, updated.assigneeId);
    }

    return { ...updated, tags: await tagsOf(tx, id) };
  });
}

// ─── STATUS ──────────────────────────────────────────────────────────────────

export async function changeStatus(id: string, status: FlawStatus, user: JwtPayload, comment?: string, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    const [current] = await tx.select().from(flaws)
      .where(and(eq(flaws.id, id), eq(flaws.tenantId, tenantId)))
      .for('update');
    if (!current) throw new NotFoundError('Flaw not found');

    assertTransition(current.status as FlawStatus, status);

    const now = new Date();
    const patch: Partial<typeof flaws.$inferInsert> = { status, updatedAt: now };
    if (status === 'FIXED' || status === 'VERIFIED') patch.resolvedAt = current.resolvedAt ?? now;
    if (status === 'CLOSED') patch.closedAt = now;
    if (status === 'REOPENED') { patch.closedAt = null; patch.resolvedAt = null; }

    const [updated] = await tx.update(flaws).set(patch).where(eq(flaws.id, id)).returning();
    await record(tx, tenantId, id, user.sub, 'STATUS_CHANGED', 'status', current.status, status);

    if (comment) {
      await tx.insert(flawComments).values({ tenantId, flawId: id, authorId: user.sub, body: comment });
      await record(tx, tenantId, id, user.sub, 'COMMENTED', undefined, undefined, { body: comment });
    }
    return updated;
  });
}

// ─── COMMENTS ────────────────────────────────────────────────────────────────

export async function addComment(id: string, body: string, user: JwtPayload, isInternal = false, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    const [flaw] = await tx.select({ id: flaws.id }).from(flaws)
      .where(and(eq(flaws.id, id), eq(flaws.tenantId, tenantId))).limit(1);
    if (!flaw) throw new NotFoundError('Flaw not found');

    const [comment] = await tx.insert(flawComments)
      .values({ tenantId, flawId: id, authorId: user.sub, body, isInternal })
      .returning();
    await record(tx, tenantId, id, user.sub, 'COMMENTED', undefined, undefined, { commentId: comment.id, isInternal });
    return comment;
  });
}

// ─── DUPLICATES ──────────────────────────────────────────────────────────────

const SUGGEST_COLUMNS = {
  id: flaws.id, reference: flaws.reference, title: flaws.title, status: flaws.status,
  moduleId: flaws.moduleId, duplicateOfId: flaws.duplicateOfId,
};

/** Fuzzy candidates for an existing flaw. Suggest-only: this never changes anything. */
export async function suggestFor(id: string, user: JwtPayload, opts: { limit?: number; minScore?: number } = {}) {
  const tenantId = await resolveTenantId(user);
  return withTenant(tenantId, async (tx) => {
    const [flaw] = await tx.select().from(flaws).where(and(eq(flaws.id, id), eq(flaws.tenantId, tenantId))).limit(1);
    if (!flaw) throw new NotFoundError('Flaw not found');

    const sameModule = flaw.moduleId
      ? await tx.select(SUGGEST_COLUMNS).from(flaws)
          .where(and(eq(flaws.tenantId, tenantId), eq(flaws.moduleId, flaw.moduleId), sql`${flaws.id} <> ${id}`))
          .orderBy(desc(flaws.createdAt)).limit(200)
      : [];
    const others = sameModule.length >= 20 ? [] : await tx.select(SUGGEST_COLUMNS).from(flaws)
      .where(and(eq(flaws.tenantId, tenantId), sql`${flaws.id} <> ${id}`,
        flaw.moduleId ? sql`${flaws.moduleId} <> ${flaw.moduleId}` : undefined))
      .orderBy(desc(flaws.createdAt)).limit(200);

    return suggestDuplicates({ id: flaw.id, title: flaw.title, moduleId: flaw.moduleId }, [...sameModule, ...others], opts);
  });
}

/**
 * Marks `id` as a duplicate of `canonicalId`.
 * A flaw may be a duplicate of exactly one canonical flaw (DB UNIQUE) and a duplicate can never be
 * canonical itself, so duplicate chains cannot form.
 */
export async function linkDuplicate(id: string, canonicalId: string, user: JwtPayload, note?: string, matchedBy = 'USER') {
  const tenantId = await resolveTenantId(user);
  return withTenant(tenantId, async (tx) => {
    // Lock both rows in id order: two concurrent links cannot deadlock.
    const rows = await tx.select().from(flaws)
      .where(and(eq(flaws.tenantId, tenantId), inArray(flaws.id, [id, canonicalId])))
      .orderBy(asc(flaws.id))
      .for('update');
    const flaw = rows.find((r) => r.id === id);
    const canon = rows.find((r) => r.id === canonicalId);
    if (!flaw) throw new NotFoundError('Flaw not found');
    if (!canon) throw new NotFoundError('The flaw to mark as canonical was not found');
    if (canon.id === flaw.id) throw new BusinessRuleError('A flaw cannot be its own duplicate');
    if (canon.duplicateOfId) throw new BusinessRuleError(`${canon.reference} is itself a duplicate of another flaw`);
    if (flaw.status === 'DUPLICATE' && flaw.duplicateOfId === canon.id) return flaw;

    const [existing] = await tx.select().from(flawDuplicates).where(eq(flawDuplicates.duplicateId, flaw.id)).limit(1);
    if (existing && existing.canonicalId !== canon.id) {
      throw new ConflictError(`${flaw.reference} is already a duplicate of another flaw`);
    }

    await tx.insert(flawDuplicates).values({
      tenantId, canonicalId: canon.id, duplicateId: flaw.id,
      relation: 'DUPLICATE_OF', matchedBy, createdById: user.sub,
    }).onConflictDoNothing();

    const [updated] = await tx.update(flaws)
      .set({ duplicateOfId: canon.id, status: 'DUPLICATE', updatedAt: new Date() })
      .where(eq(flaws.id, flaw.id))
      .returning();

    await record(tx, tenantId, flaw.id, user.sub, 'DUPLICATE_MARKED', 'duplicateOfId', flaw.duplicateOfId, canon.id);
    if (note) {
      await tx.insert(flawComments).values({
        tenantId, flawId: flaw.id, authorId: user.sub,
        body: `Marked as a duplicate of ${canon.reference}. ${note}`,
      });
    }
    return updated;
  });
}

/** Undoes a duplicate link: the flaw goes back to TRIAGED and keeps its own record. */
export async function unlinkDuplicate(id: string, user: JwtPayload, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    const [flaw] = await tx.select().from(flaws)
      .where(and(eq(flaws.id, id), eq(flaws.tenantId, tenantId)))
      .for('update');
    if (!flaw) throw new NotFoundError('Flaw not found');
    if (!flaw.duplicateOfId) throw new BusinessRuleError('This flaw is not a duplicate');

    await tx.delete(flawDuplicates).where(eq(flawDuplicates.duplicateId, flaw.id));
    const [updated] = await tx.update(flaws)
      .set({ duplicateOfId: null, status: 'TRIAGED', updatedAt: new Date() })
      .where(eq(flaws.id, flaw.id))
      .returning();
    await record(tx, tenantId, flaw.id, user.sub, 'DUPLICATE_UNMARKED', 'duplicateOfId', flaw.duplicateOfId, null);
    return updated;
  });
}

/**
 * Merges `loserId` into `survivorId`: the loser's duplicates are re-pointed at the survivor, the
 * loser becomes a duplicate of it, and both keep their full history. Nothing is deleted.
 */
export async function mergeFlaws(survivorId: string, loserId: string, user: JwtPayload, requestedTenantId?: string | null) {
  const tenantId = await resolveTenantId(user, requestedTenantId);
  return withTenant(tenantId, async (tx) => {
    if (survivorId === loserId) throw new BusinessRuleError('Cannot merge a flaw into itself');

    const rows = await tx.select().from(flaws)
      .where(and(eq(flaws.tenantId, tenantId), inArray(flaws.id, [survivorId, loserId])))
      .orderBy(asc(flaws.id))
      .for('update');
    const survivor = rows.find((r) => r.id === survivorId);
    const loser = rows.find((r) => r.id === loserId);
    if (!survivor) throw new NotFoundError('Surviving flaw not found');
    if (!loser) throw new NotFoundError('Flaw to merge not found');
    if (survivor.duplicateOfId) {
      throw new BusinessRuleError(`${survivor.reference} is itself a duplicate and cannot absorb another flaw`);
    }

    // Re-point every flaw the loser was canonical for, then drop the loser's own link rows.
    const kids = await tx.select().from(flawDuplicates).where(eq(flawDuplicates.canonicalId, loser.id));
    if (kids.length > 0) {
      await tx.delete(flawDuplicates).where(eq(flawDuplicates.canonicalId, loser.id));
      for (const kid of kids) {
        await tx.insert(flawDuplicates).values({
          tenantId, canonicalId: survivor.id, duplicateId: kid.duplicateId,
          relation: kid.relation, matchedBy: kid.matchedBy, createdById: kid.createdById,
        }).onConflictDoUpdate({ target: flawDuplicates.duplicateId, set: { canonicalId: survivor.id } });
      }
    }

    await tx.insert(flawDuplicates).values({
      tenantId, canonicalId: survivor.id, duplicateId: loser.id,
      relation: 'MERGED_INTO', matchedBy: 'USER', createdById: user.sub,
    }).onConflictDoNothing();

    const [updatedLoser] = await tx.update(flaws)
      .set({ duplicateOfId: survivor.id, status: 'DUPLICATE', updatedAt: new Date() })
      .where(eq(flaws.id, loser.id))
      .returning();

    await record(tx, tenantId, survivor.id, user.sub, 'DUPLICATE_MARKED', 'mergedFrom', loser.id, survivor.id);
    await record(tx, tenantId, loser.id, user.sub, 'DUPLICATE_MARKED', 'duplicateOfId', loser.duplicateOfId, survivor.id);

    return { survivor, merged: updatedLoser, movedDuplicates: kids.length };
  });
}