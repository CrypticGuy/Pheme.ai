import { loadConfig, saveConfig, type Saved, type Session } from './config.js';

type AuthEndpoint = { supabaseUrl: string; anonKey: string };
const trim = (url: string) => url.replace(/\/+$/, '');

async function parse(res: Response) {
  const text = await res.text();
  let value: any; try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text }; }
  if (!res.ok) throw new Error(value.msg ?? value.error_description ?? value.message ?? value.error ?? `Request failed (${res.status})`);
  return value;
}
const toSession = (v: any, email: string): Session => ({ accessToken: v.access_token, refreshToken: v.refresh_token, expiresAt: v.expires_at ?? Math.floor(Date.now() / 1000) + (v.expires_in ?? 3600), email: v.user?.email ?? email });

/** Finds the Auth endpoint and public anon key from the single Pheme URL. */
export async function bootstrap(pheme: string): Promise<AuthEndpoint> {
  const v = await parse(await fetch(`${trim(pheme)}/config`));
  if (!v.supabaseUrl || !v.anonKey) throw new Error('Server did not return an Auth configuration');
  // Local Supabase reports its docker-internal address; PHEME_SUPABASE_URL overrides it (e.g. http://127.0.0.1:55321).
  return { supabaseUrl: process.env.PHEME_SUPABASE_URL ?? v.supabaseUrl, anonKey: v.anonKey };
}
const authHeaders = (e: AuthEndpoint) => ({ apikey: e.anonKey, 'Content-Type': 'application/json' });

/** Returns a session, or null when the project requires email confirmation first. */
export async function signUp(e: AuthEndpoint, email: string, password: string): Promise<Session | null> {
  const v = await parse(await fetch(`${trim(e.supabaseUrl)}/auth/v1/signup`, { method: 'POST', headers: authHeaders(e), body: JSON.stringify({ email, password }) }));
  return v.access_token ? toSession(v, email) : null;
}
export async function signIn(e: AuthEndpoint, email: string, password: string): Promise<Session> {
  return toSession(await parse(await fetch(`${trim(e.supabaseUrl)}/auth/v1/token?grant_type=password`, { method: 'POST', headers: authHeaders(e), body: JSON.stringify({ email, password }) })), email);
}
async function refresh(e: AuthEndpoint, s: Session): Promise<Session> {
  return toSession(await parse(await fetch(`${trim(e.supabaseUrl)}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: authHeaders(e), body: JSON.stringify({ refresh_token: s.refreshToken }) })), s.email);
}
export async function signOut(e: AuthEndpoint, s: Session) {
  await fetch(`${trim(e.supabaseUrl)}/auth/v1/logout`, { method: 'POST', headers: { apikey: e.anonKey, Authorization: `Bearer ${s.accessToken}` } }).catch(() => undefined);
}

/** Returns a live access token, refreshing and persisting the session when it is about to expire. */
export async function liveSession(cfg: Saved = loadConfig()): Promise<{ cfg: Saved; token: string }> {
  if (!cfg.url || !cfg.supabaseUrl || !cfg.anonKey || !cfg.session) throw new Error('Not logged in. Run: pheme login');
  if (cfg.session.expiresAt - 60 > Date.now() / 1000) return { cfg, token: cfg.session.accessToken };
  try {
    const session = await refresh({ supabaseUrl: cfg.supabaseUrl, anonKey: cfg.anonKey }, cfg.session);
    const next = { ...cfg, session }; saveConfig(next); return { cfg: next, token: session.accessToken };
  } catch { throw new Error('Session expired. Run: pheme login'); }
}

/** Calls an account route on the Pheme function with the Auth session. */
export async function account<T>(cfg: Saved, jwt: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${trim(cfg.url!)}${path}`, {
    method, headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error'
  });
  return parse(res) as Promise<T>;
}
