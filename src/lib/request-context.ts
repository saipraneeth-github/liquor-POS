import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request facts that code far from the route (the audit log) needs without every caller passing them along.
 * `app.ts` opens one context per request (onRequest hook); `requireRole` fills it once the token is verified.
 */
export interface RequestContext { impersonatedBy?: string }
export const requestContext = new AsyncLocalStorage<RequestContext>();
