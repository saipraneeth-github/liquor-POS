import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productRoutes } from './modules/products/product.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { closingRoutes } from './modules/closing/closing.routes.js';
import { inventoryRoutes } from './modules/inventory/inventory.routes.js';
import { invoiceRoutes } from './modules/invoices/invoice.routes.js';
import { tableRoutes } from './modules/tables/table.routes.js';
import { kotRoutes } from './modules/kot/kot.routes.js';
import { schemeRoutes } from './modules/schemes/scheme.routes.js';
import { syndicateRoutes } from './modules/syndicates/syndicate.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { branchRoutes } from './modules/branches/branch.routes.js';
import { terminalRoutes } from './modules/terminals/terminal.routes.js';
import { shiftRoutes } from './modules/shifts/shift.routes.js';
import { counterSheetRoutes } from './modules/counters/counter.routes.js';
import { customerRoutes } from './modules/customers/customer.routes.js';
import { complianceRoutes } from './modules/compliance/compliance.routes.js';
import { accountingRoutes } from './modules/accounting/accounting.routes.js';
import { expenseRoutes } from './modules/expenses/expense.routes.js';
import { registerAccountingHandlers } from './modules/accounting/posting.service.js';

export function buildApp() {
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET must be set (32+ chars) in production');
  }

  const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // ─── PLUGINS ──────────────────────────────────────────────────────────────

  fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false, // relaxed for preview.html standalone UI
  });
  fastify.register(fastifyCors, { origin: process.env.CORS_ORIGIN ?? '*' });
  fastify.register(fastifyRateLimit, {
    global: false, // only applied to routes that explicitly configure it
  });
  fastify.register(fastifyStatic, {
    root: path.join(process.cwd(), 'dist/frontend'),
    prefix: '/',
    wildcard: false, // disable wildcard to handle it manually for SPA
  });

  fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? '8h' },
  });

  // ─── ROOT & UI PREVIEW ─────────────────────────────────────────────────────



  fastify.get('/preview', async (_request, reply) => {
    const htmlPath = path.resolve(process.cwd(), 'preview.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      return reply.type('text/html').send(html);
    }
    return reply.status(404).send({ error: 'preview.html not found' });
  });

  fastify.get('/favicon.ico', async (_request, reply) => {
    return reply.code(204).send();
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  // ─── ROUTES ───────────────────────────────────────────────────────────────

  fastify.register(authRoutes,      { prefix: '/api/v1' });
  fastify.register(productRoutes,   { prefix: '/api/v1' });
  fastify.register(billingRoutes,   { prefix: '/api/v1' });
  fastify.register(closingRoutes,   { prefix: '/api/v1' });
  fastify.register(inventoryRoutes, { prefix: '/api/v1' });
  fastify.register(invoiceRoutes,   { prefix: '/api/v1' });
  fastify.register(tableRoutes,     { prefix: '/api/v1' });
  fastify.register(kotRoutes,       { prefix: '/api/v1' });
  fastify.register(schemeRoutes,    { prefix: '/api/v1' });
  fastify.register(syndicateRoutes, { prefix: '/api/v1' });
  fastify.register(userRoutes,         { prefix: '/api/v1' });
  fastify.register(branchRoutes,       { prefix: '/api/v1' });
  fastify.register(terminalRoutes,     { prefix: '/api/v1' });
  fastify.register(shiftRoutes,        { prefix: '/api/v1' });
  fastify.register(counterSheetRoutes, { prefix: '/api/v1' });
  fastify.register(customerRoutes,     { prefix: '/api/v1' });
  fastify.register(complianceRoutes,   { prefix: '/api/v1' });
  fastify.register(accountingRoutes,   { prefix: '/api/v1' });
  fastify.register(expenseRoutes,      { prefix: '/api/v1' });

  // Accounting listens to domain events (bill.paid, bill.voided, …) and posts vouchers in the same transaction.
  registerAccountingHandlers();

  // ─── HEALTH ───────────────────────────────────────────────────────────────

  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return fastify;
}
