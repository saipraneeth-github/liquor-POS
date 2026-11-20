/**
 * A Super Admin "sign in as" token acts as the tenant's Admin so support can see what they see. It must not be a way to
 * take the account over or to make the Super Admin's actions look like the Admin's own: changing passwords, users, roles
 * and permissions is refused, and every audit entry made with it carries `impersonatedBy` (see lib/audit.ts).
 */
export function isBlockedForImpersonation(method: string, url: string): boolean {
  const path = url.split('?')[0].replace(/\/+$/, '');
  if (path === '/api/v1/auth/change-password') return true;
  if (path === '/api/v1/platform' || path.startsWith('/api/v1/platform/')) return true;   // the support token belongs to a tenant, never the platform
  if ((path === '/api/v1/users' || path.startsWith('/api/v1/users/')) && method.toUpperCase() !== 'GET') return true;
  return false;
}
