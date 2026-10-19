import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productRoutes } from './modules/products/product.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { closingRoutes } from './modules/closing/closing.routes.js';
import { inventoryRoutes } from './modules/inventory/inventory.routes.js';
import { tableRoutes } from './modules/tables/table.routes.js';
import { kotRoutes } from './modules/kot/kot.routes.js';
import { schemeRoutes } from './modules/schemes/scheme.routes.js';

export function buildApp() {
  const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  // ─── PLUGINS ──────────────────────────────────────────────────────────────

  fastify.register(fastifyHelmet);
  fastify.register(fastifyCors, { origin: process.env.CORS_ORIGIN ?? '*' });
  fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? '8h' },
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

  // ─── HEALTH ───────────────────────────────────────────────────────────────

  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return fastify;
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);

const app = buildApp();
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🍾 Liquor Counter API running on http://localhost:${PORT}`);
});
