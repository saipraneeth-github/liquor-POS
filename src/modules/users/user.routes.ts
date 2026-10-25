/**
 * user.routes.ts — user administration & self profile.
 *
 * GET   /me                — any authenticated user (profile, no passwordHash)
 * GET   /users?branchId=   — manager+ (manager: own branch; owner: accessible branches)
 * POST  /users             — manager+ (manager: cashier/steward in own branch; owner: any role in scope)
 * PATCH /users/:id         — manager+ (name / role / isActive; never above own role)
 * GET   /users/:id/pages   — manager+ (page-permission matrix)
 * PUT   /users/:id/pages   — manager+ (replace page-permission matrix)
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
  getUserPages,
  setUserPages,
  CreateUserSchema,
  UpdateUserSchema,
  ListUsersQuerySchema,
  SetPagesSchema,
} from './user.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/me', { preHandler: requireRole('steward') }, async (request, reply) => {
    try {
      return await getMe(getUser(request).sub);
    } catch (err) {
      return sendError(reply, err, 'Profile lookup failed');
    }
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

  fastify.get('/users/:id/pages', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    try {
      return { pages: await getUserPages(getUser(request), params.data.id) };
    } catch (err) {
      return sendError(reply, err, 'Page lookup failed');
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
