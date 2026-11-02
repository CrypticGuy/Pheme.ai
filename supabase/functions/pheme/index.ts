// Pheme broker as a Supabase Edge Function. Same HTTP API as broker.ts; state lives in Postgres.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { z } from 'npm:zod@4.1.12';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('');
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const version = z.number().int().positive();
const create = z.object({ recipient: z.string().min(1).max(80), title: z.string().min(1).max(200), text: z.string().min(1).max(50_000) }).strict();
const respond = z.object({ version, verdict: z.enum(['approve', 'request_changes', 'comment']), feedback: z.string().max(10_000).optional() }).strict();
const registerBody = z.object({ handle: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1).max(80), invite: z.string().min(8).max(200) }).strict();
const finalize = z.object({ version, action: z.enum(['close', 'hand_to_agent']), note: z.string().max(10_000).optional() }).strict();

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = /pheme:(\d{3}):(.*)/.exec(error.message);
    if (m) throw new HttpError(Number(m[1]), m[2]);
    console.error(error); throw error;
  }
  return data;
}
async function body(req: Request) {
  const text = await req.text();
  if (text.length > 100_000) throw new HttpError(413, 'Body too large');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

Deno.serve(async req => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  try {
    const url = new URL(req.url);
    // Locally the path is /pheme/..., hosted it may be /functions/v1/pheme/...
    const path = url.pathname.replace(/^\/(functions\/v1\/)?pheme(?=\/|$)/, '') || '/';
    if (req.method === 'GET' && path === '/health') return new Response(JSON.stringify({ ok: true }), { headers });
    // Public bootstrap: lets the CLI find the Auth endpoint from the one Pheme URL.
    if (req.method === 'GET' && path === '/config') return new Response(JSON.stringify({ supabaseUrl: Deno.env.get('SUPABASE_URL'), anonKey: Deno.env.get('SUPABASE_ANON_KEY') }), { headers });
    const auth = req.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer token required');
    // Account routes authenticate with a Supabase Auth session JWT, not a Pheme token.
    if (path === '/me' || path === '/register' || path === '/token/rotate') {
      const { data, error } = await db.auth.getUser(auth.slice(7));
      if (error || !data.user) throw new HttpError(401, 'Invalid or expired session; log in again');
      const authId = data.user.id;
      let account: unknown;
      if (req.method === 'GET' && path === '/me') account = await rpc('pheme_me', { p_auth: authId });
      else if (req.method === 'POST' && path === '/register') {
        const d = registerBody.parse(await body(req)), token = newToken();
        await rpc('pheme_register', { p_auth: authId, p_handle: d.handle, p_name: d.name, p_invite_hash: await sha256(d.invite), p_token_hash: await sha256(token) });
        account = { id: d.handle, name: d.name, token };
      } else if (req.method === 'POST' && path === '/token/rotate') {
        const token = newToken();
        account = { ...(await rpc('pheme_rotate', { p_auth: authId, p_token_hash: await sha256(token) }) as object), token };
      } else throw new HttpError(404, 'Not found');
      return new Response(JSON.stringify(account), { headers });
    }
    const user = (await rpc('pheme_authenticate', { p_hash: await sha256(auth.slice(7)) })) as { id: string };
    let result: unknown; const id = path.split('/')[2];
    if (req.method === 'GET' && path === '/inbox/events') {
      const until = Date.now() + Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait_ms') ?? 0) || 0));
      let events = (await rpc('pheme_events', { p_user: user.id })) as unknown[];
      while (!events.length && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now())));
        events = (await rpc('pheme_events', { p_user: user.id })) as unknown[];
      }
      result = { events };
    } else if (req.method === 'GET' && path === '/reviews') result = { reviews: await rpc('pheme_pending', { p_user: user.id }) };
    else if (req.method === 'GET' && /^\/reviews\/[^/]+$/.test(path)) result = await rpc('pheme_get_review', { p_id: id, p_user: user.id });
    else if (req.method === 'POST' && /^\/events\/[^/]+\/ack$/.test(path)) result = await rpc('pheme_ack', { p_id: id, p_user: user.id });
    else if (req.method === 'POST') {
      const key = req.headers.get('idempotency-key');
      if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new HttpError(400, 'Idempotency-Key of 8-128 safe characters required');
      const base = { p_user: user.id, p_key: key };
      if (path === '/reviews') {
        const d = create.parse(await body(req));
        result = await rpc('pheme_create', { ...base, p_fp: await sha256(JSON.stringify({ op: 'create', d })), p_recipient: d.recipient, p_title: d.title, p_text: d.text });
      } else if (/^\/reviews\/[^/]+\/response$/.test(path)) {
        const d = respond.parse(await body(req));
        result = await rpc('pheme_respond', { ...base, p_fp: await sha256(JSON.stringify({ op: `respond:${id}`, d })), p_id: id, p_version: d.version, p_verdict: d.verdict, p_feedback: d.feedback ?? null });
      } else if (/^\/reviews\/[^/]+\/finalize$/.test(path)) {
        const d = finalize.parse(await body(req));
        result = await rpc('pheme_finalize', { ...base, p_fp: await sha256(JSON.stringify({ op: `finalize:${id}`, d })), p_id: id, p_version: d.version, p_action: d.action, p_note: d.note ?? null });
      } else throw new HttpError(404, 'Not found');
    } else throw new HttpError(404, 'Not found');
    return new Response(JSON.stringify(result), { headers });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
    return new Response(JSON.stringify({ error: status === 500 ? 'Internal error' : err instanceof Error ? err.message : 'Request failed' }), { status, headers });
  }
});
