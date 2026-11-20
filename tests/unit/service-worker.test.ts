import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

/**
 * Runs the real public/sw.js in a sandbox with a fake Cache API and fake network, and checks what it will and will not do.
 * The fake cache behaves like the browser's: a URL fragment (#...) is ignored when matching.
 */
const SOURCE = readFileSync('frontend/public/sw.js', 'utf8');
const ORIGIN = 'http://shop.local';

type Handler = (e: Record<string, unknown>) => void;

function makeWorld() {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (r: Request | string) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url).split('#')[0];
  const makeCache = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: Request | string) => m.get(keyOf(r))?.clone(),
      put: async (r: Request | string, res: Response) => { m.set(keyOf(r), res); },
      // like the browser's: fetches the URL and stores the answer, failing when the network does
      add: async (r: Request | string) => {
        const res = await network(typeof r === 'string' ? new Req(r) : r);
        if (!res.ok) throw new TypeError('bad response');
        m.set(keyOf(r), res);
      },
      addAll: async (list: string[]) => { for (const r of list) m.set(keyOf(r), new Response('file')); },
    };
  };
  const caches = {
    open: async (n: string) => makeCache(n),
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };

  const state = { skipped: false };
  let network: (req: Request) => Promise<Response> = async () => { throw new TypeError('offline'); };
  const handlers: Record<string, Handler> = {};
  class Req extends Request { constructor(i: string | Request, init?: RequestInit) { super(typeof i === 'string' ? new URL(i, ORIGIN).href : i, init); } }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
    skipWaiting: async () => { state.skipped = true; },
    clients: { claim: async () => undefined },
  };
  const sandbox = { self, caches, fetch: (r: Request) => network(r), Request: Req, Response, Headers, URL, TextEncoder, crypto: globalThis.crypto, Promise };
  vm.runInNewContext(SOURCE, sandbox);

  /** Sends a request through the worker. Returns undefined when the worker left it alone (the browser handles it normally). */
  async function send(url: string, opts: { method?: string; auth?: string; navigate?: boolean } = {}): Promise<Response | undefined | 'THROWN'> {
    const headers: Record<string, string> = opts.auth ? { Authorization: opts.auth } : {};
    const request = Object.assign(new Request(new URL(url, ORIGIN).href, { method: opts.method ?? 'GET', headers }), {});
    Object.defineProperty(request, 'mode', { value: opts.navigate ? 'navigate' : 'cors' });
    let answer: Promise<Response> | undefined;
    handlers.fetch({ request, respondWith: (p: Promise<Response>) => { answer = p; } });
    if (!answer) return undefined;
    try { return await answer; } catch { return 'THROWN'; }
  }
  return {
    stores, caches, handlers, send, state,
    setNetwork: (fn: (req: Request) => Promise<Response>) => { network = fn; },
    online: (body = '{"ok":true}', status = 200, type = 'application/json') => { network = async () => new Response(body, { status, headers: { 'content-type': type } }); },
    offline: () => { network = async () => { throw new TypeError('offline'); }; },
  };
}

let w: ReturnType<typeof makeWorld>;
beforeEach(() => { w = makeWorld(); });

const PRODUCTS = '/api/v1/products?branchId=11111111-1111-4111-8111-111111111111';

describe('service worker: what it leaves alone', () => {
  it('writes, other sites and unlisted API calls go straight through', async () => {
    w.online();
    expect(await w.send('/api/v1/bills', { method: 'POST', auth: 'Bearer a' })).toBeUndefined();
    expect(await w.send('/api/v1/bills/22222222-2222-4222-8222-222222222222', { auth: 'Bearer a' })).toBeUndefined();   // not on the offline list
    expect(await w.send('/api/v1/customers/11111111-1111-4111-8111-111111111111', { auth: 'Bearer a' })).toBeUndefined();
    const other = new Request('https://checkout.razorpay.com/v1/checkout.js');
    let touched = false;
    w.handlers.fetch({ request: other, respondWith: () => { touched = true; } });
    expect(touched).toBe(false);
  });
});

describe('service worker: read-only data for offline use', () => {
  it('serves the last good copy when the network is down, marked as offline', async () => {
    w.online('{"products":[1,2]}');
    const live = (await w.send(PRODUCTS, { auth: 'Bearer alice' })) as Response;
    expect(await live.text()).toBe('{"products":[1,2]}');
    w.offline();
    const saved = (await w.send(PRODUCTS, { auth: 'Bearer alice' })) as Response;
    expect(saved.headers.get('X-Served-Offline')).toBe('1');
    expect(await saved.text()).toBe('{"products":[1,2]}');
  });

  it('never gives one signed-in person another person\'s saved data', async () => {
    w.online('{"products":["alice-only"]}');
    await w.send(PRODUCTS, { auth: 'Bearer alice' });
    w.offline();
    expect(await w.send(PRODUCTS, { auth: 'Bearer bob' })).toBe('THROWN');          // bob has nothing saved: the request fails honestly
    expect(((await w.send(PRODUCTS, { auth: 'Bearer alice' })) as Response).status).toBe(200);
    // and the token itself is not stored anywhere in a cache key
    const keys = [...w.stores.get('lc-data-v1')!.keys()].join(' ');
    expect(keys).not.toContain('alice');
    expect(keys).toContain('__lcu=');
  });

  it('keeps nothing for a request without a token, and nothing that failed', async () => {
    w.online('{"products":[]}');
    await w.send(PRODUCTS);                                                           // not signed in
    w.online('{"error":"boom"}', 500);
    await w.send(PRODUCTS, { auth: 'Bearer alice' });                                 // a server error
    w.online('{"error":"no"}', 401);
    await w.send('/api/v1/me', { auth: 'Bearer alice' });                             // an ended session must not be replayed
    const store = w.stores.get('lc-data-v1');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('is wiped on sign-out', async () => {
    w.online();
    await w.send(PRODUCTS, { auth: 'Bearer alice' });
    expect(w.stores.get('lc-data-v1')!.size).toBe(1);
    w.handlers.message({ data: { type: 'clear-data' }, waitUntil: (p: Promise<unknown>) => p });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.stores.has('lc-data-v1')).toBe(false);
  });
});

describe('service worker: the page and the built files', () => {
  it('opens the saved page when the shop is offline, and prefers the network when online', async () => {
    w.online('<html>v1</html>', 200, 'text/html; charset=utf-8');
    expect(await ((await w.send('/pos', { navigate: true })) as Response).text()).toBe('<html>v1</html>');
    w.offline();
    expect(await ((await w.send('/closing', { navigate: true })) as Response).text()).toBe('<html>v1</html>');   // any route opens the app
    w.online('<html>v2</html>', 200, 'text/html');
    expect(await ((await w.send('/pos', { navigate: true })) as Response).text()).toBe('<html>v2</html>');        // a new release wins
  });

  it('with no saved page and no network it fails honestly instead of inventing one', async () => {
    w.offline();
    expect(await w.send('/pos', { navigate: true })).toBe('THROWN');
  });

  it('keeps built files after the first load (cache-first)', async () => {
    let hits = 0;
    w.setNetwork(async () => { hits++; return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } }); });
    await w.send('/assets/POS-abc123.js');
    await w.send('/assets/POS-abc123.js');
    expect(hits).toBe(1);
    w.offline();
    expect(((await w.send('/assets/POS-abc123.js')) as Response).status).toBe(200);
  });
});

describe('service worker: install', () => {
  it('keeps every listed built file on the device, so a screen never visited still opens offline', async () => {
    w.setNetwork(async (req) => {
      const u = String((req as unknown as { url?: string }).url ?? req);
      if (u.endsWith('/precache.json')) return new Response(JSON.stringify(['/assets/Bills-aaa.js', '/assets/Closing-bbb.js']));
      return new Response('code');
    });
    let done: Promise<unknown> | undefined;
    w.handlers.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    w.offline();                                                                   // the shop's internet goes down...
    expect(((await w.send('/assets/Bills-aaa.js')) as Response).status).toBe(200);   // ...and the Bills screen, never opened, still loads
    expect(((await w.send('/assets/Closing-bbb.js')) as Response).status).toBe(200);
    expect(w.state.skipped).toBe(true);
  });

  it('tries a file that failed the first time once more, so no screen is missing from the device', async () => {
    let tries = 0;
    w.setNetwork(async (req) => {
      const u = String((req as unknown as { url?: string }).url ?? req);
      if (u.endsWith('/precache.json')) return new Response(JSON.stringify(['/assets/Bills-aaa.js', '/assets/Closing-bbb.js']));
      if (u.endsWith('Bills-aaa.js') && tries++ === 0) throw new TypeError('connection dropped');   // the first attempt fails
      return new Response('code');
    });
    let done: Promise<unknown> | undefined;
    w.handlers.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(tries).toBe(2);
    w.offline();
    expect(((await w.send('/assets/Bills-aaa.js')) as Response).status).toBe(200);
  });

  it('still installs when the list cannot be fetched (a flaky connection must not block the worker)', async () => {
    w.offline();
    let done: Promise<unknown> | undefined;
    w.handlers.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await expect(done).resolves.toBeUndefined();
    expect(w.state.skipped).toBe(true);
  });
});

describe('service worker: housekeeping', () => {
  it('drops caches of older versions when it activates', async () => {
    await w.caches.open('lc-shell-v0');
    await w.caches.open('lc-data-v1');
    await w.caches.open('someone-elses-cache');
    let done: Promise<unknown> | undefined;
    w.handlers.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    const left = await w.caches.keys();
    expect(left).not.toContain('lc-shell-v0');
    expect(left).toContain('lc-data-v1');
    expect(left).toContain('someone-elses-cache');   // only its own prefix is touched
  });
});

describe('installable app files', () => {
  it('has a valid manifest with 192 and 512 icons that exist and are the right size', () => {
    const m = JSON.parse(readFileSync('frontend/public/manifest.webmanifest', 'utf8'));
    expect(m).toMatchObject({ display: 'standalone', start_url: '/', scope: '/' });
    for (const size of ['192x192', '512x512']) {
      const icon = m.icons.find((i: { sizes: string; purpose: string }) => i.sizes === size && i.purpose === 'any');
      expect(icon, `icon ${size}`).toBeTruthy();
      const file = `frontend/public${icon.src}`;
      expect(existsSync(file)).toBe(true);
      const png = readFileSync(file);
      expect(png.readUInt32BE(16)).toBe(Number(size.split('x')[0]));   // PNG IHDR width
    }
    expect(m.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  });

  it('is linked from the page', () => {
    const html = readFileSync('frontend/index.html', 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
  });
});
