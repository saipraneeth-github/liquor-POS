/**
 * platform.routes.ts — Super Admin (platform owner) back office + the Admin's own subscription view.
 *
 * GET   /api/v1/platform/overview        — totals across all tenants (platform owner)
 * GET   /api/v1/platform/dashboard       — MRR, plan mix, trial funnel, billed revenue by month, "needs action" queue (platform owner)
 * GET   /api/v1/platform/tenants         — tenants with plan, usage and admins (platform owner)
 * POST  /api/v1/platform/tenants         — create a tenant and its first Admin (platform owner)
 * PATCH /api/v1/platform/tenants/:id     — plan, branch limit, suspend / activate (platform owner)
 * GET   /api/v1/platform/tenants/:id/invoices, POST (generate) · POST /platform/invoices/:id/pay
 * POST  /api/v1/platform/tenants/:id/admins/:userId/reset-password · POST /platform/tenants/:id/impersonate
 * POST  /api/v1/platform/tenants/:id/archive {reason} · POST .../restore · GET .../export · GET .../delete-preview · POST .../delete {confirmName, acknowledge}
 * GET   /api/v1/platform/roles · POST /platform/roles · PATCH /platform/roles/:id · POST /platform/roles/:id/retire|reactivate · PUT /platform/users/:id/role {roleId}
 * GET   /api/v1/platform/branches?search=&tenantId=&status=&featureOff= · GET /platform/branches/:id · PUT /platform/branches/:id/features {features:{key:boolean}}
 * POST  /api/v1/platform/invoices/:id/void
 * GET   /api/v1/platform/plans · POST /platform/plans · PATCH /platform/plans/:code · POST /platform/plans/:code/retire|reactivate
 * GET   /api/v1/platform/tenants/:id/plan-preview?plan=&effective= · POST /platform/tenants/:id/plan · DELETE /platform/tenants/:id/plan/scheduled
 * GET   /api/v1/tenant/plans             — the plans on sale (Admin)
 * GET   /api/v1/platform/users · PATCH /platform/users/:id {isActive} · POST /platform/users/:id/reset-password
 * GET   /api/v1/platform/audit?actor=&action=&tenantId=&from=&to=&limit=&offset= · GET /platform/audit/actions
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
  AuditQuerySchema,
  ListUsersSchema,
  SetUserActiveSchema,
  auditActions,
  listPlatformUsers,
  recentAudit,
  resetPlatformUserPassword,
  resetTenantAdminPassword,
  searchAudit,
  setPlatformUserActive,
  CreateTenantSchema,
  UpdateTenantSchema,
  createTenant,
  listTenants,
  platformOverview,
  platformDashboard,
  tenantSnapshot,
  tenantSummary,
  updateTenant,
} from './platform.service.js';
import {
  ActivePlanSchema,
  AssignPlanSchema,
  CreatePlanSchema,
  UpdatePlanSchema,
  assignPlan,
  cancelScheduledPlan,
  createPlan,
  listPlans,
  previewPlanChange,
  setPlanActive,
  updatePlan,
} from './plans.service.js';
import {
  ArchiveSchema,
  DeleteSchema,
  archiveTenant,
  deletePreview,
  deleteTenant,
  exportTenant,
  restoreTenant,
  voidInvoice,
} from './tenant-lifecycle.service.js';
import {
  ActiveRoleSchema, AssignRoleSchema, CreateRoleSchema, UpdateRoleSchema,
  assignRole, assignableRoles, createRole, listRoles, setRoleActive, updateRole,
} from '../permissions/roles.service.js';
import { ListBranchesSchema, SetFeaturesSchema, getPlatformBranch, listPlatformBranches, setBranchFeatures } from './branch-admin.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const CodeParams = z.object({ code: z.string().trim().toUpperCase().min(2).max(30) });
const PreviewQuery = z.object({ plan: z.string().trim().toUpperCase().min(2).max(30), effective: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
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

  app.get('/platform/dashboard', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return platformDashboard();
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
      const before = await tenantSnapshot(params.data.id);
      const updated = await updateTenant(params.data.id, body.data);
      await logAudit(getUser(req).sub, 'tenant.update', { type: 'tenant', id: updated.id }, { ...body.data, before, after: await tenantSnapshot(updated.id) });
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
    const q = AuditQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed', details: q.error.flatten() });
    return searchAudit(q.data);
  });

  app.get('/platform/audit/actions', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return { actions: await auditActions() };
  });

  // ── Roles: the built-in ones, and the custom ones the Super Admin defines ──
  app.get('/platform/roles', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return { ...(await listRoles()), assignable: await assignableRoles() };
  });

  app.post('/platform/roles', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const body = CreateRoleSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return reply.code(201).send(await createRole(getUser(req).sub, body.data)); } catch (err) { return sendError(reply, err, 'Could not create the role'); }
  });

  app.patch('/platform/roles/:id', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = UpdateRoleSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Role not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await updateRole(getUser(req).sub, params.data.id, body.data); } catch (err) { return sendError(reply, err, 'Could not update the role'); }
  });

  for (const [path, isActive] of [['retire', false], ['reactivate', true]] as const) {
    app.post(`/platform/roles/:id/${path}`, { preHandler: owner }, async (req, reply) => {
      if (!(await superAdminOnly(getUser(req), reply))) return;
      const params = IdParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'Role not found' });
      try { return await setRoleActive(getUser(req).sub, params.data.id, isActive); } catch (err) { return sendError(reply, err, 'Could not update the role'); }
    });
  }

  app.put('/platform/users/:id/role', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = AssignRoleSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    if (!body.success) return reply.code(400).send({ error: 'Choose a role' });
    try { return await assignRole(getUser(req).sub, params.data.id, body.data.roleId); } catch (err) { return sendError(reply, err, 'Could not change the role'); }
  });

  // ── Branches across every business, and the features each one has ──
  app.get('/platform/branches', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const q = ListBranchesSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed', details: q.error.flatten() });
    return listPlatformBranches(q.data);
  });

  app.get('/platform/branches/:id', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    try { return await getPlatformBranch(params.data.id); } catch (err) { return sendError(reply, err, 'Could not load the branch'); }
  });

  app.put('/platform/branches/:id/features', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = SetFeaturesSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await setBranchFeatures(getUser(req).sub, params.data.id, body.data); } catch (err) { return sendError(reply, err, 'Could not change the features'); }
  });

  // ── Lifecycle: archive, restore, export, delete (after 30 days, name typed) ──
  app.post('/platform/tenants/:id/archive', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = ArchiveSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await archiveTenant(getUser(req).sub, params.data.id, body.data.reason); } catch (err) { return sendError(reply, err, 'Could not archive the business'); }
  });

  app.post('/platform/tenants/:id/restore', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    try { return await restoreTenant(getUser(req).sub, params.data.id); } catch (err) { return sendError(reply, err, 'Could not restore the business'); }
  });

  app.get('/platform/tenants/:id/export', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    try { return await exportTenant(getUser(req).sub, params.data.id); } catch (err) { return sendError(reply, err, 'Could not export the data'); }
  });

  app.get('/platform/tenants/:id/delete-preview', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    try { return await deletePreview(params.data.id); } catch (err) { return sendError(reply, err, 'Could not work out what would be deleted'); }
  });

  app.post('/platform/tenants/:id/delete', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = DeleteSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    if (!body.success) return reply.code(400).send({ error: 'Type the business name and confirm that this cannot be undone' });
    try { return await deleteTenant(getUser(req).sub, params.data.id, body.data.confirmName); } catch (err) { return sendError(reply, err, 'Could not delete the business'); }
  });

  app.post('/platform/invoices/:id/void', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Invoice not found' });
    try { return await voidInvoice(getUser(req).sub, params.data.id); } catch (err) { return sendError(reply, err, 'Could not void the invoice'); }
  });

  // ── Plans: the catalog, and moving businesses between plans ──
  app.get('/platform/plans', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return { plans: await listPlans() };
  });

  app.post('/platform/plans', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const body = CreatePlanSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return reply.code(201).send(await createPlan(getUser(req).sub, body.data)); } catch (err) { return sendError(reply, err, 'Could not create the plan'); }
  });

  app.patch('/platform/plans/:code', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = CodeParams.safeParse(req.params);
    const body = UpdatePlanSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Plan not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await updatePlan(getUser(req).sub, params.data.code, body.data); } catch (err) { return sendError(reply, err, 'Could not update the plan'); }
  });

  for (const [path, isActive] of [['retire', false], ['reactivate', true]] as const) {
    app.post(`/platform/plans/:code/${path}`, { preHandler: owner }, async (req, reply) => {
      if (!(await superAdminOnly(getUser(req), reply))) return;
      const params = CodeParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'Plan not found' });
      try { return await setPlanActive(getUser(req).sub, params.data.code, isActive); } catch (err) { return sendError(reply, err, 'Could not update the plan'); }
    });
  }

  app.get('/platform/tenants/:id/plan-preview', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const query = PreviewQuery.safeParse(req.query);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });
    try { return await previewPlanChange(params.data.id, query.data.plan, query.data.effective); } catch (err) { return sendError(reply, err, 'Could not work out the change'); }
  });

  app.post('/platform/tenants/:id/plan', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = AssignPlanSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await assignPlan(getUser(req).sub, params.data.id, body.data); } catch (err) { return sendError(reply, err, 'Could not change the plan'); }
  });

  app.delete('/platform/tenants/:id/plan/scheduled', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Tenant not found' });
    try { return await cancelScheduledPlan(getUser(req).sub, params.data.id); } catch (err) { return sendError(reply, err, 'Could not cancel the change'); }
  });

  // What an Admin can choose from on the subscription screen: plans on sale, never the trial
  app.get('/tenant/plans', { preHandler: requireRole('owner', { allowLocked: true }) }, async () => {
    const plans = await listPlans({ includeRetired: false });
    return { plans: plans.filter((p) => p.code !== 'TRIAL').map(({ code, name, price, cycleDays, maxBranches, features }) => ({ code, name, price, cycleDays, maxBranches, features })) };
  });

  // ── Users across every business ──
  app.get('/platform/users', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const q = ListUsersSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed', details: q.error.flatten() });
    return listPlatformUsers(q.data);
  });

  app.patch('/platform/users/:id', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    const body = SetUserActiveSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try { return await setPlatformUserActive(getUser(req).sub, params.data.id, body.data.isActive); } catch (err) { return sendError(reply, err, 'Could not update the user'); }
  });

  app.post('/platform/users/:id/reset-password', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'User not found' });
    try { return await resetPlatformUserPassword(getUser(req).sub, params.data.id); } catch (err) { return sendError(reply, err, 'Password reset failed'); }
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
