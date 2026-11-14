/**
 * user.routes.ts — user administration & self profile.
 *
 * GET   /me                — any authenticated user (profile, no passwordHash)
 * GET   /users?branchId=   — manager+ (manager: own branch; owner: accessible branches)
 * POST  /users             — manager+ (manager: cashier/steward in own branch; owner: any role in scope)
 * PATCH /users/:id         — manager+ (name / role / isActive; never above own role)
 * GET   /users/:id/pages   — manager+ (page-permission matrix)
 * PUT   /users/:id/pages   — manager+ (replace page-permission matrix)
 * GET   /users/:id/permissions — manager+ (actions + sale types a user may use)
 * PUT   /users/:id/permissions — manager+ (overrides on the role defaults; only users below the actor)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  getMe,
  listUsers,
  createUser,
  updateUser,
  resetUserPassword,
  getUserPages,
  setUserPages,
  getUserPermissions,
  setUserPermissions,
  SetPermissionsSchema,
  SetRoleSchema,
  listAssignableRolesFor,
  setUserRole,
  CreateUserSchema,
  UpdateUserSchema,
  ListUsersQuerySchema,
  SetPagesSchema,
} from './user.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/me', { preHandler: requireRole('steward', { allowLocked: true }) }, async (request, reply) => {
    try {
      // `access` tells the app to show the subscription screen instead of the pages when the tenant is locked
      const access = (request as unknown as { tenantAccess?: string }).tenantAccess ?? 'OK';
      return { ...(await getMe(getUser(request).sub)), access };
    } catch (err) {
      return sendError(reply, err, 'Profile lookup failed');
    }
  });

  // The roles this person may give to their staff (built-in ones below them, and custom ones they hold every permission of)
  fastify.get('/roles', { preHandler: requireRole('manager') }, async (request) => ({ roles: await listAssignableRolesFor(getUser(request)) }));

  fastify.put('/users/:id/role', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const body = SetRoleSchema.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    if (!body.success) return reply.code(400).send({ error: 'Choose a role' });
    try { return await setUserRole(getUser(request), params.data.id, body.data.roleId); } catch (err) { return sendError(reply, err, 'Could not change the role'); }
  });

  fastify.get('/users', { preHandler: requireRole('manager') }, async (request, reply) => {
    const parsed = ListUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return await listUsers(getUser(request), parsed.data.branchId);
    } catch (err) {
      return sendError(reply, err, 'User listing failed');
    }
  });

  fastify.post('/users', { preHandler: requireRole('manager') }, async (request, reply) => {
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      const user = await createUser(getUser(request), parsed.data);
      return reply.code(201).send(user);
    } catch (err) {
      return sendError(reply, err, 'User creation failed');
    }
  });

  fastify.patch('/users/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    const parsed = UpdateUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return await updateUser(getUser(request), params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'User update failed');
    }
  });

  // Temporary password for a user in scope (manager+ for their staff, Admin for managers)
  fastify.post('/users/:id/reset-password', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    try {
      return await resetUserPassword(getUser(request), params.data.id);
    } catch (err) {
      return sendError(reply, err, 'Password reset failed');
    }
  });

  fastify.get('/users/:id/pages', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    try {
      return { pages: await getUserPages(getUser(request), params.data.id) };
    } catch (err) {
      return sendError(reply, err, 'Page lookup failed');
    }
  });

  // What a user may do (cost prices, prices, stock moves, approvals, voids, big discounts) and which sale types a cashier may use.
  // Manager+ — and only for users below them; nobody can grant what they do not hold.
  fastify.get('/users/:id/permissions', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    try {
      return await getUserPermissions(getUser(request), params.data.id);
    } catch (err) {
      return sendError(reply, err, 'Permission lookup failed');
    }
  });

  fastify.put('/users/:id/permissions', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    const parsed = SetPermissionsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return await setUserPermissions(getUser(request), params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Permission update failed');
    }
  });

  fastify.put('/users/:id/pages', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    const parsed = SetPagesSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return { pages: await setUserPages(getUser(request), params.data.id, parsed.data.pages) };
    } catch (err) {
      return sendError(reply, err, 'Page update failed');
    }
  });
}
