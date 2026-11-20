/**
 * Super Admin: the platform's master catalog (state product list, no prices) and the platform categories.
 *   GET   /platform/master/products?state=&q=&category=&active=&limit=&offset=
 *   PATCH /platform/master/products/:id          edit a product (brand, pack, SKU, category, name, discontinue)
 *   POST  /platform/master/import {rows:[…]}     add / refresh many (creates missing platform categories)
 *   GET   /platform/master/categories            POST (create) · PATCH /:id (name, GST %)
 * A change to brand / pack / SKU / category raises the product's revision, which shows businesses "update available".
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, isPlatformOwner } from '../../middleware/auth.guard.js';
import { db } from '../../db/client.js';
import { sendError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { adminListCategories, adminListMaster, adminSaveCategory, adminUpdateMaster, upsertMasterProducts } from '../catalog/catalog.service.js';

async function superAdminOnly(user: JwtPayload, reply: FastifyReply): Promise<boolean> {
  if (await isPlatformOwner(user)) return true;
  reply.code(403).send({ error: 'Forbidden: Super Admin only' });
  return false;
}

const SAFE = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[<>]/.test(s), 'Must not contain < or >');
const Row = z.object({
  state: z.string().trim().min(2).max(4).toUpperCase().default('TS'),
  categoryName: SAFE(60), name: SAFE(200), brand: SAFE(120),
  volumeMl: z.coerce.number().int().min(1).max(20000), packQuantity: z.coerce.number().int().min(1).max(1000),
  exciseCode: SAFE(10), sku: SAFE(64),
  barcodes: z.array(SAFE(64)).max(10).optional(),
});
const Id = z.object({ id: z.string().uuid() });

export async function masterRoutes(app: FastifyInstance) {
  const owner = requireRole('owner');

  app.get('/platform/master/products', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    const q = z.object({
      state: z.string().max(4).optional(), q: z.string().max(100).optional(), category: z.string().max(60).optional(),
      active: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed' });
    return adminListMaster({ ...q.data, active: q.data.active === undefined ? undefined : q.data.active === '1' });
  });

  app.patch('/platform/master/products/:id', { preHandler: owner }, async (req, reply) => {
    const user = getUser(req);
    if (!(await superAdminOnly(user, reply))) return;
    const id = Id.safeParse(req.params);
    const body = z.object({
      name: SAFE(200).optional(), brand: SAFE(120).optional(), categoryName: SAFE(60).optional(),
      packQuantity: z.coerce.number().int().min(1).max(1000).optional(), sku: SAFE(64).optional(), isActive: z.boolean().optional(),
    }).strict().safeParse(req.body);
    if (!id.success) return reply.code(404).send({ error: 'Master product not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const { before, after } = await adminUpdateMaster(id.data.id, body.data);
      await logAudit(user.sub, 'master.product.update', { type: 'master_product', id: id.data.id }, {
        before: { brand: before.brand, packQuantity: before.packQuantity, sku: before.sku, categoryName: before.categoryName, isActive: before.isActive, revision: before.revision },
        after: { brand: after.brand, packQuantity: after.packQuantity, sku: after.sku, categoryName: after.categoryName, isActive: after.isActive, revision: after.revision },
      });
      return after;
    } catch (err) { return sendError(reply, err, 'Could not update the master product'); }
  });

  app.post('/platform/master/import', { preHandler: owner }, async (req, reply) => {
    const user = getUser(req);
    if (!(await superAdminOnly(user, reply))) return;
    const body = z.object({ rows: z.array(Row).min(1).max(5000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const result = await db.transaction((tx) => upsertMasterProducts(body.data.rows, tx));
      await logAudit(user.sub, 'master.import', undefined, { ...result, rows: body.data.rows.length });
      return reply.code(201).send(result);
    } catch (err) { return sendError(reply, err, 'Import failed'); }
  });

  app.get('/platform/master/categories', { preHandler: owner }, async (req, reply) => {
    if (!(await superAdminOnly(getUser(req), reply))) return;
    return adminListCategories();
  });

  const CatBody = z.object({ name: SAFE(60), taxRate: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'GST must be like 18 or 5.5').refine((v) => Number(v) <= 100, 'GST cannot exceed 100') });
  app.post('/platform/master/categories', { preHandler: owner }, async (req, reply) => {
    const user = getUser(req);
    if (!(await superAdminOnly(user, reply))) return;
    const body = CatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const row = await adminSaveCategory(body.data);
      await logAudit(user.sub, 'master.category.create', { type: 'category', id: row.id }, { name: row.name, taxRate: row.taxRate });
      return reply.code(201).send(row);
    } catch (err) { return sendError(reply, err, 'Could not save the category'); }
  });
  app.patch('/platform/master/categories/:id', { preHandler: owner }, async (req, reply) => {
    const user = getUser(req);
    if (!(await superAdminOnly(user, reply))) return;
    const id = Id.safeParse(req.params);
    const body = CatBody.safeParse(req.body);
    if (!id.success) return reply.code(404).send({ error: 'Category not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const row = await adminSaveCategory({ ...body.data, id: id.data.id });
      await logAudit(user.sub, 'master.category.update', { type: 'category', id: row.id }, { name: row.name, taxRate: row.taxRate });
      return row;
    } catch (err) { return sendError(reply, err, 'Could not save the category'); }
  });
}
