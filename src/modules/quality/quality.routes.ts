/**
 * quality.routes.ts — HTTP layer for the flaw / defect tracker.
 *
 * All routes live under /api/v1/quality (registered in app.ts with prefix '/quality').
 * Minimum role: cashier. Manager+ required for writes that change shared state.
 *
 * Tenant resolution is syndicate-scoped: the service's resolveTenantId() handles platform owners
 * (who must pass ?tenantId=) and normal users (pinned to their own syndicate). Routes pass
 * request.query.tenantId through so the service can apply its own guard.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, flawLinks, flawTags, flawTagMap, flawWatchers, qualityModules, flaws, users } from '../../db/schema.js';
import { requireRole, getUser } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { withTenant } from '../../db/tenant-rls.js';
import { tenantOf } from '../menu/menu-access.js';
import { ForbiddenError, NotFoundError, BusinessRuleError } from '../../lib/errors.js';

/** A module's owner and parent must belong to the same business: an id from another business is refused, never stored. */
async function assertModuleRefsInTenant(tx: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: string, refs: { parentId?: string | null; ownerId?: string | null; selfId?: string }) {
  if (refs.parentId) {
    if (refs.parentId === refs.selfId) throw new BusinessRuleError('A module cannot be its own parent');
    const [parent] = await tx.select({ id: qualityModules.id }).from(qualityModules)
      .where(and(eq(qualityModules.id, refs.parentId), eq(qualityModules.tenantId, tenantId))).limit(1);
    if (!parent) throw new BusinessRuleError('Parent module not found in this tenant');
  }
  if (refs.ownerId) {
    const [owner] = await tx.select({ id: users.id }).from(users)
      .leftJoin(branches, eq(users.branchId, branches.id))
      .where(and(eq(users.id, refs.ownerId), sql`coalesce(${users.syndicateId}, ${branches.syndicateId}) = ${tenantId}`)).limit(1);
    if (!owner) throw new BusinessRuleError('Owner must be a user of this business');
  }
}
import {
  createFlaw,
  listFlaws,
  getFlaw,
  updateFlaw,
  changeStatus,
  addComment,
  suggestFor,
  linkDuplicate,
  unlinkDuplicate,
  mergeFlaws,
  CreateFlawSchema,
  UpdateFlawSchema,
  StatusSchema,
  LinkDuplicateSchema,
  ListFlawsQuerySchema,
  CreateModuleSchema,
  FLAW_STATUS_VALUES,
} from './quality.service.js';

// ─── PARAM SCHEMAS ───────────────────────────────────────────────────────────

const IdParams = z.object({ id: z.string().uuid() });
const IdLinkIdParams = z.object({ id: z.string().uuid(), linkId: z.string().uuid() });

// ─── TENANT HELPER ───────────────────────────────────────────────────────────

/**
 * Resolves the caller's tenantId for inline DB calls (links, tags, watchers, modules).
 * Platform owners must supply ?tenantId=. Everyone else is pinned to their own syndicate.
 */
async function resolveTenant(user: ReturnType<typeof getUser>, requestedTenantId?: string | null): Promise<string> {
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

// ─── COMMENT / LINK BODY SCHEMAS (inline; not in service) ────────────────────

const CommentBodySchema = z.object({
  body:       z.string().trim().min(1).max(5_000),
  isInternal: z.boolean().optional().default(false),
});

const AddLinkBodySchema = z.object({
  targetId: z.string().uuid(),
  linkType: z.enum(['BLOCKS', 'BLOCKED_BY', 'RELATES_TO']),
});

const CreateTagBodySchema = z.object({
  name:  z.string().trim().min(1).max(30),
  color: z.string().trim().max(20).optional(),
});

const MergeBodySchema = z.object({
  survivorId: z.string().uuid(),
});

const TenantQuerySchema = z.object({ tenantId: z.string().uuid().optional() });

// ─── ROUTES ──────────────────────────────────────────────────────────────────

export async function qualityRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════════
  // MODULES (quality_modules — the product/feature tree)
  // All module routes: manager+
  // ════════════════════════════════════════════════════════════════════════════

  // GET /quality/modules — list all active modules for the tenant
  fastify.get('/modules', { preHandler: requireRole('manager') }, async (request, reply) => {
    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, (tx) =>
        tx.select().from(qualityModules).where(eq(qualityModules.tenantId, tenantId))
      );
    } catch (err) {
      return sendError(reply, err, 'Failed to list modules');
    }
  });

  // POST /quality/modules — create a module
  fastify.post('/modules', { preHandler: requireRole('manager') }, async (request, reply) => {
    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    const parsed = CreateModuleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const input = parsed.data;
        await assertModuleRefsInTenant(tx, tenantId, { parentId: input.parentId, ownerId: input.ownerId });
        const [mod] = await tx.insert(qualityModules).values({
          tenantId,
          key:         input.key,
          name:        input.name,
          parentId:    input.parentId ?? null,
          description: input.description ?? null,
          ownerId:     input.ownerId ?? null,
        }).returning();
        return reply.code(201).send(mod);
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to create module');
    }
  });

  // GET /quality/modules/:id — fetch one module (tenant-checked)
  fastify.get('/modules/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid module id' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const [mod] = await tx.select().from(qualityModules)
          .where(and(eq(qualityModules.id, params.data.id), eq(qualityModules.tenantId, tenantId)))
          .limit(1);
        if (!mod) throw new NotFoundError('Module not found');
        return mod;
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to fetch module');
    }
  });

  // PATCH /quality/modules/:id — update a module
  fastify.patch('/modules/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid module id' });

    const UpdateModuleSchema = CreateModuleSchema.partial();
    const parsed = UpdateModuleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const [current] = await tx.select().from(qualityModules)
          .where(and(eq(qualityModules.id, params.data.id), eq(qualityModules.tenantId, tenantId)))
          .limit(1);
        if (!current) throw new NotFoundError('Module not found');

        const input = parsed.data;
        await assertModuleRefsInTenant(tx, tenantId, { parentId: input.parentId, ownerId: input.ownerId, selfId: params.data.id });
        const [updated] = await tx.update(qualityModules)
          .set({
            ...(input.key         !== undefined && { key: input.key }),
            ...(input.name        !== undefined && { name: input.name }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.parentId    !== undefined && { parentId: input.parentId }),
            ...(input.ownerId     !== undefined && { ownerId: input.ownerId }),
            updatedAt: new Date(),
          })
          .where(eq(qualityModules.id, params.data.id))
          .returning();
        return updated;
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to update module');
    }
  });

  // DELETE /quality/modules/:id — soft-delete (is_active = false)
  fastify.delete('/modules/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid module id' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const [current] = await tx.select({ id: qualityModules.id }).from(qualityModules)
          .where(and(eq(qualityModules.id, params.data.id), eq(qualityModules.tenantId, tenantId)))
          .limit(1);
        if (!current) throw new NotFoundError('Module not found');
        await tx.update(qualityModules)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(qualityModules.id, params.data.id));
        return reply.code(204).send();
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to archive module');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FLAWS
  // ════════════════════════════════════════════════════════════════════════════

  // POST /quality/flaws — create a flaw (cashier+). 201 new, 409 exact dup.
  fastify.post('/flaws', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    const parsed = CreateFlawSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    try {
      const result = await createFlaw(parsed.data, user, tq.success ? tq.data.tenantId : undefined);
      return reply.code(201).send(result);
    } catch (err) {
      return sendError(reply, err, 'Failed to create flaw');
    }
  });

  // GET /quality/flaws — list flaws (cashier+)
  fastify.get('/flaws', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const user = getUser(request);
    const parsed = ListFlawsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    // tenantId extracted separately since ListFlawsQuerySchema doesn't include it
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      return await listFlaws(parsed.data, user, tq.success ? tq.data.tenantId : undefined);
    } catch (err) {
      return sendError(reply, err, 'Failed to list flaws');
    }
  });

  // GET /quality/flaws/:id — get one flaw with comments, history, duplicates (cashier+)
  fastify.get('/flaws/:id', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      return await getFlaw(params.data.id, user, tq.success ? tq.data.tenantId : undefined);
    } catch (err) {
      return sendError(reply, err, 'Failed to fetch flaw');
    }
  });

  // PATCH /quality/flaws/:id — update flaw fields (manager+)
  fastify.patch('/flaws/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const parsed = UpdateFlawSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      return await updateFlaw(params.data.id, parsed.data, user, tq.success ? tq.data.tenantId : undefined);
    } catch (err) {
      return sendError(reply, err, 'Failed to update flaw');
    }
  });

  // POST /quality/flaws/:id/status — transition status (cashier+)
  fastify.post('/flaws/:id/status', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const parsed = StatusSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      return await changeStatus(
        params.data.id,
        parsed.data.status,
        user,
        parsed.data.comment,
        tq.success ? tq.data.tenantId : undefined,
      );
    } catch (err) {
      return sendError(reply, err, 'Status change failed');
    }
  });

  // GET /quality/flaws/:id/suggestions — fuzzy duplicate suggestions (cashier+)
  fastify.get('/flaws/:id/suggestions', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const user = getUser(request);
    const SuggestQuerySchema = z.object({
      limit:    z.coerce.number().int().min(1).max(20).optional(),
      minScore: z.coerce.number().min(0).max(1).optional(),
    });
    const opts = SuggestQuerySchema.safeParse(request.query);
    try {
      return await suggestFor(params.data.id, user, opts.success ? opts.data : {});
    } catch (err) {
      return sendError(reply, err, 'Failed to get suggestions');
    }
  });

  // POST /quality/flaws/:id/comments — add a comment (cashier+)
  fastify.post('/flaws/:id/comments', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const parsed = CommentBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const comment = await addComment(
        params.data.id,
        parsed.data.body,
        user,
        parsed.data.isInternal,
        tq.success ? tq.data.tenantId : undefined,
      );
      return reply.code(201).send(comment);
    } catch (err) {
      return sendError(reply, err, 'Failed to add comment');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // DUPLICATE MANAGEMENT
  // ════════════════════════════════════════════════════════════════════════════

  // POST /quality/flaws/:id/duplicate — link as duplicate (manager+)
  fastify.post('/flaws/:id/duplicate', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const parsed = LinkDuplicateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    try {
      return await linkDuplicate(params.data.id, parsed.data.canonicalId, user, parsed.data.note);
    } catch (err) {
      return sendError(reply, err, 'Failed to link duplicate');
    }
  });

  // DELETE /quality/flaws/:id/duplicate — unlink duplicate (manager+)
  fastify.delete('/flaws/:id/duplicate', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      return await unlinkDuplicate(params.data.id, user, tq.success ? tq.data.tenantId : undefined);
    } catch (err) {
      return sendError(reply, err, 'Failed to unlink duplicate');
    }
  });

  // POST /quality/flaws/:id/merge — merge :id (loser) into survivorId (manager+)
  fastify.post('/flaws/:id/merge', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const parsed = MergeBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'survivorId is required (UUID)' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      return await mergeFlaws(
        parsed.data.survivorId,   // survivor
        params.data.id,           // loser = :id
        user,
        tq.success ? tq.data.tenantId : undefined,
      );
    } catch (err) {
      return sendError(reply, err, 'Merge failed');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // LINKS (blocks / blocked-by / relates-to)  — inline DB calls (not in service)
  // ════════════════════════════════════════════════════════════════════════════

  // POST /quality/flaws/:id/links — add a link (manager+)
  fastify.post('/flaws/:id/links', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const parsed = AddLinkBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        // Verify source flaw belongs to tenant
        const [source] = await tx.select({ id: flaws.id }).from(flaws)
          .where(and(eq(flaws.id, params.data.id), eq(flaws.tenantId, tenantId))).limit(1);
        if (!source) throw new NotFoundError('Flaw not found');

        // Verify target flaw belongs to tenant
        const [target] = await tx.select({ id: flaws.id }).from(flaws)
          .where(and(eq(flaws.id, parsed.data.targetId), eq(flaws.tenantId, tenantId))).limit(1);
        if (!target) throw new NotFoundError('Target flaw not found');

        if (params.data.id === parsed.data.targetId) {
          throw new BusinessRuleError('A flaw cannot link to itself');
        }

        const [link] = await tx.insert(flawLinks).values({
          tenantId,
          sourceId:    params.data.id,
          targetId:    parsed.data.targetId,
          linkType:    parsed.data.linkType,
          createdById: user.sub,
        }).returning();
        return reply.code(201).send(link);
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to add link');
    }
  });

  // DELETE /quality/flaws/:id/links/:linkId — remove a link (manager+)
  fastify.delete('/flaws/:id/links/:linkId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdLinkIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid params' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        // The link must have its source (or target) on a flaw that belongs to this tenant.
        const [link] = await tx.select().from(flawLinks)
          .where(and(eq(flawLinks.id, params.data.linkId), eq(flawLinks.tenantId, tenantId)))
          .limit(1);
        if (!link) throw new NotFoundError('Link not found');

        await tx.delete(flawLinks).where(eq(flawLinks.id, params.data.linkId));
        return reply.code(204).send();
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to remove link');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TAGS  — inline DB calls (not in service)
  // ════════════════════════════════════════════════════════════════════════════

  // GET /quality/tags — list tags for tenant (cashier+)
  fastify.get('/tags', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, (tx) =>
        tx.select().from(flawTags).where(eq(flawTags.tenantId, tenantId))
      );
    } catch (err) {
      return sendError(reply, err, 'Failed to list tags');
    }
  });

  // POST /quality/tags — create a tag (manager+)
  fastify.post('/tags', { preHandler: requireRole('manager') }, async (request, reply) => {
    const parsed = CreateTagBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const name = parsed.data.name.trim().toLowerCase();
        const [tag] = await tx.insert(flawTags).values({
          tenantId,
          name,
          color: parsed.data.color ?? null,
        }).onConflictDoUpdate({
          target: [flawTags.tenantId, flawTags.name],
          set: { color: parsed.data.color ?? null },
        }).returning();
        return reply.code(201).send(tag);
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to create tag');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // WATCHERS  — inline DB calls (not in service)
  // ════════════════════════════════════════════════════════════════════════════

  // POST /quality/flaws/:id/watch — subscribe (cashier+)
  fastify.post('/flaws/:id/watch', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const [flaw] = await tx.select({ id: flaws.id }).from(flaws)
          .where(and(eq(flaws.id, params.data.id), eq(flaws.tenantId, tenantId))).limit(1);
        if (!flaw) throw new NotFoundError('Flaw not found');

        await tx.insert(flawWatchers)
          .values({ flawId: params.data.id, userId: user.sub })
          .onConflictDoNothing();
        return reply.code(201).send({ flawId: params.data.id, userId: user.sub, watching: true });
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to add watcher');
    }
  });

  // DELETE /quality/flaws/:id/watch — unsubscribe (cashier+)
  fastify.delete('/flaws/:id/watch', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid flaw id' });

    const user = getUser(request);
    const tq = TenantQuerySchema.safeParse(request.query);
    try {
      const tenantId = await resolveTenant(user, tq.success ? tq.data.tenantId : undefined);
      return await withTenant(tenantId, async (tx) => {
        const [flaw] = await tx.select({ id: flaws.id }).from(flaws)
          .where(and(eq(flaws.id, params.data.id), eq(flaws.tenantId, tenantId))).limit(1);
        if (!flaw) throw new NotFoundError('Flaw not found');

        await tx.delete(flawWatchers)
          .where(and(eq(flawWatchers.flawId, params.data.id), eq(flawWatchers.userId, user.sub)));
        return reply.code(204).send();
      });
    } catch (err) {
      return sendError(reply, err, 'Failed to remove watcher');
    }
  });
}
