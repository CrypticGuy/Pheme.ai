// Shared plumbing for the Supabase smoke and e2e tests. Local by default; for a hosted project set
// PHEME_SUPABASE_URL and PHEME_SUPABASE_SERVICE_ROLE_KEY. With an explicit key, users are created pre-confirmed
// (no emails are sent) and everything a run created is deleted afterwards.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

export const api = (process.env.PHEME_SUPABASE_URL ?? 'http://127.0.0.1:55321').replace(/\/+$/, '');
export const url = `${api}/functions/v1/pheme`;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 })}`;
export const explicitKey = process.env.PHEME_SUPABASE_SERVICE_ROLE_KEY;
const serviceKey = explicitKey ?? `${unsigned}.${createHmac('sha256', 'super-secret-jwt-token-with-at-least-32-characters-long').update(unsigned).digest('base64url')}`;
export const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
export const sfx = randomBytes(3).toString('hex');

export async function rpc(fn: string, args: object) {
  const res = await fetch(`${api}/rest/v1/rpc/${fn}`, { method: 'POST', headers: admin, body: JSON.stringify(args) });
  const text = await res.text();
  assert.ok(res.ok, `${fn}: ${text}`); return text ? JSON.parse(text) : null;
}
export const allow = (email: string, connectWith: string[] = []) => rpc('pheme_allow_email', { p_email: email, p_connect_with: connectWith });
export const connect = (x: string, y: string) => rpc('pheme_connect', { p_x: x, p_y: y });

export const emails: string[] = [], handles: string[] = [], authUsers: string[] = [];
/** Creates a confirmed Auth user through the admin API (hosted); locally returns false and the caller signs up. */
export async function adminUser(email: string, password: string) {
  emails.push(email);
  if (!explicitKey) return false;
  const res = await fetch(`${api}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) });
  const created = await res.json() as { id: string }; assert.ok(res.ok, JSON.stringify(created)); authUsers.push(created.id);
  return true;
}
export async function cleanup() {
  if (!explicitKey && !api.includes('127.0.0.1')) return;
  const rest = async (table: string, filter: string) => { const r = await fetch(`${api}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: admin }); if (!r.ok) console.error(`cleanup ${table}: ${await r.text()}`); };
  const list = `in.(${handles.join(',')})`;
  // Allowlist rows reference users, so they go first.
  if (emails.length) await rest('pheme_allowed_emails', `email=in.(${emails.map(e => e.toLowerCase()).join(',')})`);
  if (handles.length) {
    await rest('pheme_events', `inbox=${list}`); await rest('pheme_reviews', `owner=${list}`);
    await rest('pheme_keys', `scoped_key=like.*${sfx}*`); await rest('pheme_users', `id=${list}`);
  }
  // Local sign-ups create Auth users we did not record; find them by email.
  if (!explicitKey) {
    const all = await (await fetch(`${api}/auth/v1/admin/users?per_page=200`, { headers: admin })).json() as { users: { id: string; email: string }[] };
    for (const u of all.users) if (emails.includes(u.email)) authUsers.push(u.id);
  }
  for (const id of authUsers) await fetch(`${api}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: admin });
}
