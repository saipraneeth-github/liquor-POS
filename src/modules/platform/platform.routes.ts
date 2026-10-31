/**
 * platform.routes.ts — Super Admin (platform owner) back office + the Admin's own subscription view.
 *
 * GET   /api/v1/platform/overview        — totals across all tenants (platform owner)
 * GET   /api/v1/platform/tenants         — tenants with plan, usage and admins (platform owner)
 * POST  /api/v1/platform/tenants         — create a tenant and its first Admin (platform owner)
 * PATCH /api/v1/platform/tenants/:id     — plan, branch limit, suspend / activate (platform owner)
 * GET   /api/v1/platform/tenants/:id/invoices, POST (generate) · POST /platform/invoices/:id/pay
 * POST  /api/v1/platform/tenants/:id/admins/:userId/reset-password · POST /platform/tenants/:id/impersonate
 * GET   /api/v1/platform/audit
 * GET   /api/v1/tenant/me                — plan and branch usage of the caller's own business (Admin)
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, isPlatformOwner } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { logAudit } from '../../lib/audit.js';
import { db } from '../../db/client.js';
import { and, eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import {
  generateInvoice,
  listInvoices,
  markInvoicePaid,
  recentAudit,
  resetTenantAdminPassword,
  CreateTenantSchema,
  UpdateTenantSchema,
  createTenant,
  listTenants,
  platformOverview,
  tenantSummary,
  updateTenant,
} from './platform.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const AdminParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const PaySchema = z.object({ paymentRef: z.string().trim().min(1).max(100) });

async function superAdminOnly(user: JwtPayload, reply: FastifyReply): Promise<boolean> {
  if (await isPlatformOwner(user)) return true;
  reply.code(403).send({ error: 'Forbidden: Super Admin only' });
  return false;
}

export async function platformRoutes(app: FastifyInstance) {
  const owner = requireRole('owner');

  app.get('/platform/overview', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return platformOverview();
  });

  app.get('/platform/tenants', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return { tenants: await listTenants() };
  });

  app.post('/platform/tenants', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const body = CreateTenantSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const created = await createTenant(body.data);
      await logAudit(getUser(req).sub, 'tenant.create', { type: 'tenant', id: created.tenant.id }, { plan: body.data.plan });
      return reply.code(201).send(created);
    } catch (err) {
      return sendError(reply, err, 'Could not create tenant');
    }
  });

  app.patch('/platform/tenants/:id', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    const body = UpdateTenantSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const updated = await updateTenant(params.data.id, body.data);
      await logAudit(getUser(req).sub, 'tenant.update', { type: 'tenant', id: updated.id }, body.data);
      return updated;
    } catch (err) {
      return sendError(reply, err, 'Could not update tenant');
    }
  });

  app.get('/platform/tenants/:id/invoices', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    return { invoices: await listInvoices(params.data.id) };
  });

  app.post('/platform/tenants/:id/invoices', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    try {
      return reply.code(201).send(await generateInvoice(params.data.id, getUser(req).sub));
    } catch (err) {
      return sendError(reply, err, 'Could not generate invoice');
    }
  });

  app.post('/platform/invoices/:id/pay', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = PaySchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Invoice not found' });
    if (!body.success) return reply.code(400).send({ error: 'A payment reference is required' });
    try {
      return await markInvoicePaid(params.data.id, body.data.paymentRef, getUser(req).sub);
    } catch (err) {
      return sendError(reply, err, 'Could not record payment');
    }
  });

  // Temporary password for a tenant Admin who is locked out (shown once to the Super Admin)
  app.post('/platform/tenants/:id/admins/:userId/reset-password', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = AdminParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Admin not found' });
    try {
      return await resetTenantAdminPassword(params.data.id, params.data.userId, getUser(req).sub);
    } catch (err) {
      return sendError(reply, err, 'Password reset failed');
    }
  });

  // Support sign-in: a 30 minute token for the tenant's first active Admin, recorded in the audit log
  app.post('/platform/tenants/:id/impersonate', { preHandler: owner }, async (req, reply) => {
    const actor = getUser(req);
    if (!(await superAdminOnly(actor, reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    const [admin] = await db.select().from(users)
      .where(and(eq(users.syndicateId, params.data.id), eq(users.role, 'owner'), eq(users.isActive, true))).limit(1);
    if (!admin) return reply.code(404).send({ error: 'This tenant has no active Admin' });
    await logAudit(actor.sub, 'support.sign_in_as', { type: 'user', id: admin.id }, { tenantId: params.data.id });
    const token = app.jwt.sign(
      { sub: admin.id, email: admin.email, role: admin.role, branchId: null, syndicateId: admin.syndicateId, impersonatedBy: actor.sub },
      { expiresIn: '30m' },
    );
    return { token, as: { name: admin.name, email: admin.email } };
  });

  app.get('/platform/audit', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return { events: await recentAudit(50) };
  });

  // The Admin's own invoices
  app.get('/tenant/invoices', { preHandler: requireRole('owner', { allowLocked: true }) }, async (req, reply) => {
    const user = getUser(req);
    if (!user.syndicateId) return reply.code(404).send({ error: 'No business is linked to this account' });
    return { invoices: await listInvoices(user.syndicateId) };
  });

  app.get('/tenant/me', { preHandler: requireRole('owner', { allowLocked: true }) }, async (req, reply) => {
    const user = getUser(req);
    if (!user.syndicateId) return reply.code(404).send({ error: 'No business is linked to this account' });
    try {
      return await tenantSummary(user.syndicateId);
    } catch (err) {
      return sendError(reply, err, 'Could not load business');
    }
  });
}
