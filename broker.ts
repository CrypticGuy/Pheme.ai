import { createServer, type IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, HttpError } from './store.js';
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 100_000) throw new HttpError(413, 'Body too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
const version = z.number().int().positive();
const create = z.object({ recipient: z.string().min(1).max(80), title: z.string().min(1).max(200), text: z.string().min(1).max(50_000) }).strict();
const respond = z.object({ version, verdict: z.enum(['approve', 'request_changes', 'comment']), feedback: z.string().max(10_000).optional() }).strict();
const finalize = z.object({ version, action: z.enum(['close', 'hand_to_agent']), note: z.string().max(10_000).optional() }).strict();
export function createBroker(store: Store) {
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { res.end(JSON.stringify({ ok: true })); return; }
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer token required');
      const user = store.authenticate(auth.slice(7)); let result: unknown;
      if (req.method === 'GET' && url.pathname === '/inbox/events') {
        const until = Date.now() + Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait_ms') ?? 0) || 0));
        let events = store.events(user.id);
        while (!events.length && Date.now() < until && !res.destroyed) {
          await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now())));
          if (res.destroyed) return;
          events = store.events(user.id);
        }
        result = { events };
      } else if (req.method === 'GET' && url.pathname === '/reviews') result = { reviews: store.pending(user.id) };
      else if (req.method === 'GET' && /^\/reviews\/[^/]+$/.test(url.pathname)) result = store.getReview(url.pathname.split('/')[2], user.id);
      else if (req.method === 'POST' && /^\/events\/[^/]+\/ack$/.test(url.pathname)) result = store.ack(url.pathname.split('/')[2], user.id);
      else if (req.method === 'POST') {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new HttpError(400, 'Idempotency-Key of 8-128 safe characters required');
        if (url.pathname === '/reviews') result = store.create(user.id, key, create.parse(await body(req)));
        else if (/^\/reviews\/[^/]+\/response$/.test(url.pathname)) result = store.respond(user.id, key, url.pathname.split('/')[2], respond.parse(await body(req)));
        else if (/^\/reviews\/[^/]+\/finalize$/.test(url.pathname)) result = store.finalize(user.id, key, url.pathname.split('/')[2], finalize.parse(await body(req)));
        else throw new HttpError(404, 'Not found');
      } else throw new HttpError(404, 'Not found');
      if (!res.destroyed) res.end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
      res.statusCode = status; res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : err instanceof Error ? err.message : 'Request failed' }));
      if (status === 500) console.error(err);
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = new Store(process.env.PHEME_DB ?? 'data/pheme.sqlite');
  const server = createBroker(store), host = process.env.PHEME_BIND ?? '127.0.0.1', port = Number(process.env.PHEME_PORT ?? 8787);
  server.listen(port, host, () => console.error(`Pheme on http://${host}:${port}. HTTP exposes bearer tokens and review text; use a trusted LAN or TLS tunnel.`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.closeAllConnections(); server.close(() => { store.close(); process.exit(0); }); });
}
