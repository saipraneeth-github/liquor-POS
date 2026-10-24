import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productRoutes } from './modules/products/product.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { closingRoutes } from './modules/closing/closing.routes.js';
import { inventoryRoutes } from './modules/inventory/inventory.routes.js';
import { tableRoutes } from './modules/tables/table.routes.js';
import { kotRoutes } from './modules/kot/kot.routes.js';
import { schemeRoutes } from './modules/schemes/scheme.routes.js';
import { syndicateRoutes } from './modules/syndicates/syndicate.routes.js';

export function buildApp() {
  const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // ─── PLUGINS ──────────────────────────────────────────────────────────────

  fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false, // relaxed for preview.html standalone UI
  });
  fastify.register(fastifyCors, { origin: process.env.CORS_ORIGIN ?? '*' });
  fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? '8h' },
  });

  // ─── ROOT & UI PREVIEW ─────────────────────────────────────────────────────

  fastify.get('/', async (request, reply) => {
    const accept = request.headers.accept ?? '';
    if (accept.includes('text/html')) {
      const htmlPath = path.resolve(process.cwd(), 'preview.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        return reply.type('text/html').send(html);
      }
    }
    return {
      name: 'Liquor Counter POS API',
      version: '0.1.0',
      status: 'running',
      preview: '/preview',
      health: '/health',
      endpoints: '/api/v1',
    };
  });

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

  // ─── ROUTES ───────────────────────────────────────────────────────────────

  fastify.register(authRoutes,      { prefix: '/api/v1' });
  fastify.register(productRoutes,   { prefix: '/api/v1' });
  fastify.register(billingRoutes,   { prefix: '/api/v1' });
  fastify.register(closingRoutes,   { prefix: '/api/v1' });
  fastify.register(inventoryRoutes, { prefix: '/api/v1' });
  fastify.register(tableRoutes,     { prefix: '/api/v1' });
  fastify.register(kotRoutes,       { prefix: '/api/v1' });
  fastify.register(schemeRoutes,    { prefix: '/api/v1' });
  fastify.register(syndicateRoutes, { prefix: '/api/v1' });

  // ─── HEALTH ───────────────────────────────────────────────────────────────

  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return fastify;
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);

const app = buildApp();
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🍾 Liquor Counter API running on http://localhost:${PORT}`);
});
