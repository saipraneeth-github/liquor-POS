import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertPaymentsSafeForProduction } from './config/integrations.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productRoutes } from './modules/products/product.routes.js';
import { menuRoutes } from './modules/menu/menu.routes.js';
import { printRoutes } from './modules/printing/print.routes.js';
import { pourRoutes } from './modules/compliance/pour.routes.js';
import { agentRoutes } from './modules/printing/agent.routes.js';
import { platformRoutes } from './modules/platform/platform.routes.js';
import { paymentRoutes, webhookRoutes } from './modules/payments/payment.routes.js';
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
import { saleTypeRoutes } from './modules/saletypes/saletype.routes.js';
import { customerRoutes } from './modules/customers/customer.routes.js';
import { complianceRoutes } from './modules/compliance/compliance.routes.js';
import { accountingRoutes } from './modules/accounting/accounting.routes.js';
import { expenseRoutes } from './modules/expenses/expense.routes.js';
import { bankRoutes } from './modules/bank/bank.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { registerAccountingHandlers } from './modules/accounting/posting.service.js';
import { registerCounterSheetHandlers } from './modules/counters/counter.service.js';

export function buildApp() {
  const isProd = process.env.NODE_ENV === 'production';
  const isTest = process.env.NODE_ENV === 'test';
  if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('JWT_SECRET must be set (32+ chars) in production');
  }
  if (isProd && (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*')) {
    throw new Error('CORS_ORIGIN must be set to the web app origin(s) in production (not "*")');
  }
  assertPaymentsSafeForProduction();
  // A random per-process secret would silently invalidate every session on restart, so only tests may omit it.
  if (!isProd && !isTest && !process.env.JWT_SECRET) {
    console.warn('[warn] JWT_SECRET is not set: using a random secret, sessions will not survive a restart');
  }

  // Behind a reverse proxy / load balancer every request arrives from the proxy's address, which would make the
  // per-IP rate limits and the login lockout treat all users as one client. TRUST_PROXY: "true", a hop count
  // (e.g. "1"), or a comma-separated list of proxy IPs/CIDRs. Leave unset when clients connect directly.
  const trustProxyEnv = process.env.TRUST_PROXY?.trim();
  const trustProxy: boolean | string[] | ((address: string, hop: number) => boolean) =
    !trustProxyEnv ? false
    : trustProxyEnv === 'true' ? true
    : trustProxyEnv === 'false' ? false
    : Number.isInteger(Number(trustProxyEnv)) ? ((hops) => (_address: string, hop: number) => hop < hops)(Number(trustProxyEnv))
    : trustProxyEnv.split(',').map((s) => s.trim());

  const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    trustProxy,
  });

  // ─── PLUGINS ──────────────────────────────────────────────────────────────

  // CSP protects the React SPA (no inline scripts). Razorpay Checkout is loaded by the SPA's subscription panel.
  // This POS is often served over plain HTTP on a shop LAN (http://192.168.x.x:3001). Helmet's defaults would
  // break that: `upgrade-insecure-requests` makes the browser re-request assets over https (blank page), and the
  // COOP header is ignored on untrusted origins and can interfere with the gateway's payment popups.
  fastify.register(fastifyHelmet, {
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: null,
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://*.razorpay.com'],
        frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
  });
  fastify.register(fastifyCors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : '*',
  });
  fastify.register(fastifyRateLimit, {
    global: false, // only applied to routes that explicitly configure it
  });
  // Serve React SPA static assets only when built (dist/frontend exists).
  // In dev mode (npm run dev), the SPA is served by Vite's dev server on a separate port.
  const spaDistDir = path.join(process.cwd(), 'dist/frontend');
  if (fs.existsSync(spaDistDir)) {
    fastify.register(fastifyStatic, {
      root: spaDistDir,
      prefix: '/',
      index: false,
      wildcard: false, // SPA fallback is handled by setNotFoundHandler below
    });
  }

  fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? randomBytes(32).toString('hex'),
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? '8h' },
  });

  // ─── ROOT ──────────────────────────────────────────────────────────────────

  // The React app owns "/" once it is built (npm run build:frontend). Anything that is not asking for HTML, or a
  // server with no build, gets a small JSON description of the API instead.
  fastify.get('/', async (request, reply) => {
    const accept = request.headers.accept ?? '';
    const spaIndex = path.join(process.cwd(), 'dist/frontend/index.html');
    if (accept.includes('text/html') && fs.existsSync(spaIndex)) {
      return reply.type('text/html').send(fs.readFileSync(spaIndex, 'utf8'));
    }
    return {
      name: 'Liquor Counter POS API', version: '0.1.0', health: '/health', api: '/api/v1',
      ...(fs.existsSync(spaIndex) ? {} : { ui: 'The web app is not built on this server: run "npm run build:frontend", or use the Vite dev server (npm run dev:frontend).' }),
    };
  });

  fastify.get('/favicon.ico', async (_request, reply) => {
    return reply.code(204).send();
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // For SPA routes — only works when dist/frontend is built
    if (fs.existsSync(path.join(process.cwd(), 'dist/frontend/index.html'))) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  // ─── ROUTES ───────────────────────────────────────────────────────────────

  fastify.register(authRoutes,      { prefix: '/api/v1' });
  fastify.register(productRoutes,   { prefix: '/api/v1' });
  fastify.register(menuRoutes,      { prefix: '/api/v1' });
  fastify.register(printRoutes,     { prefix: '/api/v1' });
  fastify.register(pourRoutes,      { prefix: '/api/v1' });
  fastify.register(agentRoutes,     { prefix: '/api/v1' });
  fastify.register(platformRoutes,  { prefix: '/api/v1' });
  fastify.register(paymentRoutes,   { prefix: '/api/v1' });
  fastify.register(webhookRoutes,   { prefix: '/api/v1' });   // own scope: raw body for signature checks
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
  fastify.register(saleTypeRoutes,     { prefix: '/api/v1' });
  fastify.register(customerRoutes,     { prefix: '/api/v1' });
  fastify.register(complianceRoutes,   { prefix: '/api/v1' });
  fastify.register(accountingRoutes,   { prefix: '/api/v1' });
  fastify.register(expenseRoutes,      { prefix: '/api/v1' });
  fastify.register(bankRoutes,         { prefix: '/api/v1' });
  fastify.register(dashboardRoutes,    { prefix: '/api/v1' });

  // Accounting listens to domain events (bill.paid, bill.voided, …) and posts vouchers in the same transaction.
  registerAccountingHandlers();
  registerCounterSheetHandlers();

  // ─── HEALTH ───────────────────────────────────────────────────────────────

  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
  // Same check under the API prefix, so the sign-in screen can show "server reachable" through the dev proxy too
  fastify.get('/api/v1/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return fastify;
}
