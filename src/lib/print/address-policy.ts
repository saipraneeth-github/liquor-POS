import net from 'node:net';
import dns from 'node:dns/promises';

/**
 * Where the server may open a printer connection. The printer host is typed by a tenant, and the server connects to it from
 * inside its own network, so without a policy a tenant could aim it at the cloud metadata address, the database host or the
 * server itself.
 *  - always refused: unspecified (0.0.0.0, ::) and link-local (169.254.0.0/16 incl. the cloud metadata address, fe80::/10)
 *  - refused in production: loopback (127.0.0.0/8, ::1); tests and a developer's fake printer use it
 *  - refused when PRINTER_BLOCK_PRIVATE=1 (a shared hosted install, where no tenant has a LAN printer behind this server):
 *    10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7
 * A LAN receipt printer normally sits in a private range, so those stay allowed by default.
 */
export function ipBlockReason(ip: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 0) return 'an unspecified address';
    if (a === 169 && b === 254) return 'a link-local address';
    if (a === 127 && env.NODE_ENV === 'production') return 'a loopback address';
    if (env.PRINTER_BLOCK_PRIVATE === '1' && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))) {
      return 'a private network address';
    }
    return null;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::') return 'an unspecified address';
    if (/^fe[89ab]/.test(l)) return 'a link-local address';
    if (l === '::1' && env.NODE_ENV === 'production') return 'a loopback address';
    if (env.PRINTER_BLOCK_PRIVATE === '1' && /^f[cd]/.test(l)) return 'a private network address';
    return null;
  }
  return null;
}

/** Host as typed (IP literal or name). Names are checked again when they are resolved, at connection time. */
export function hostBlockReason(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const h = host.trim().toLowerCase();
  if (net.isIP(h)) return ipBlockReason(h, env);
  if ((h === 'localhost' || h.endsWith('.localhost')) && env.NODE_ENV === 'production') return 'a loopback address';
  if (h === 'metadata.google.internal') return 'a link-local address';
  return null;
}

/** Resolves a printer host and returns an address that passes the policy, so a name cannot hide a blocked address. */
export async function resolvePrinterAddress(host: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const direct = hostBlockReason(host, env);
  if (direct) throw new Error(`Printer host ${host} is ${direct}, which is not allowed`);
  if (net.isIP(host)) return host;
  const answers = await dns.lookup(host, { all: true });
  if (answers.length === 0) throw new Error(`Printer host ${host} did not resolve`);
  for (const a of answers) {
    const reason = ipBlockReason(a.address, env);
    if (reason) throw new Error(`Printer host ${host} resolves to ${reason}, which is not allowed`);
  }
  return answers[0].address;
}
