/**
 * menu.routes.ts — Kitchen / Bar menu management.
 *
 * GET    /api/v1/menu/:type                    — list items (steward+); ?includeInactive=true (manager+)
 * POST   /api/v1/menu/:type                    — create item (manager+)
 * GET    /api/v1/menu/items/:id                — one item with servings (steward+)
 * PATCH  /api/v1/menu/items/:id                — edit item / change rate / availability (manager+)
 * PUT    /api/v1/menu/items/:id/servings       — replace the serving list (bar, manager+)
 * DELETE /api/v1/menu/items/:id                — soft delete (manager+)
 * PUT    /api/v1/menu/items/:id/branch-availability — switch an item on/off for one branch (manager+)
 * GET    /api/v1/menu/items/:id/price-history  — rate history (manager+)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, roleRank, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  MENU_TYPES,
  CreateMenuItemSchema,
  UpdateMenuItemSchema,
  ReplaceServingsSchema,
  listMenuItems,
  getMenuItem,
  createMenuItem,
  updateMenuItem,
  replaceServings,
  deleteMenuItem,
  getPriceHistory,
  setBranchAvailability,
} from './menu.service.js';
import { tenantOf } from './menu-access.js';

const TypeParams = z.object({ type: z.enum(MENU_TYPES) });
const IdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
  branchId: z.string().uuid().optional(),      // show availability as this branch sees it
});
const BranchAvailabilitySchema = z.object({ branchId: z.string().uuid(), isAvailable: z.boolean() });

export async function menuRoutes(app: FastifyInstance) {
  app.get('/menu/:type', { preHandler: requireRole('steward') }, async (req, reply) => {
    const params = TypeParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Unknown menu' });
    const query = ListQuery.safeParse(req.query);
    const wantsInactive = query.success && query.data.includeInactive === 'true';
    const user = getUser(req);
    const branchId = query.success ? query.data.branchId : undefined;
    if (branchId && !(await assertBranchAccess(user, branchId, reply))) return;
    const items = await listMenuItems(params.data.type, await tenantOf(user), wantsInactive && roleRank(user.role) >= 3, branchId);
    return { items };
  });

  app.post('/menu/:type', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = TypeParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Unknown menu' });
    const body = CreateMenuItemSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const user = getUser(req);
      return reply.code(201).send(await createMenuItem(params.data.type, body.data, user, await tenantOf(user)));
    } catch (err) {
      return sendError(reply, err, 'Could not create menu item');
    }
  });

  app.get('/menu/items/:id', { preHandler: requireRole('steward') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Menu item not found' });
    try {
      return await getMenuItem(params.data.id, await tenantOf(getUser(req)));
    } catch (err) {
      return sendError(reply, err, 'Lookup failed');
    }
  });

  app.patch('/menu/items/:id', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Menu item not found' });
    const body = UpdateMenuItemSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const user = getUser(req);
      return await updateMenuItem(params.data.id, body.data, user, await tenantOf(user));
    } catch (err) {
      return sendError(reply, err, 'Could not update menu item');
    }
  });

  app.put('/menu/items/:id/servings', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Menu item not found' });
    const body = ReplaceServingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const user = getUser(req);
      return await replaceServings(params.data.id, body.data.servings, user, await tenantOf(user));
    } catch (err) {
      return sendError(reply, err, 'Could not save servings');
    }
  });

  app.delete('/menu/items/:id', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Menu item not found' });
    try {
      await deleteMenuItem(params.data.id, await tenantOf(getUser(req)));
      return { success: true };
    } catch (err) {
      return sendError(reply, err, 'Could not delete menu item');
    }
  });

  app.put('/menu/items/:id/branch-availability', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Menu item not found' });
    const body = BranchAvailabilitySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      await setBranchAvailability(params.data.id, body.data.branchId, body.data.isAvailable, await tenantOf(user));
      return { success: true };
    } catch (err) {
      return sendError(reply, err, 'Could not update availability');
    }
  });

  app.get('/menu/items/:id/price-history', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Menu item not found' });
    try {
      return { history: await getPriceHistory(params.data.id, await tenantOf(getUser(req))) };
    } catch (err) {
      return sendError(reply, err, 'Could not load price history');
    }
  });
}
