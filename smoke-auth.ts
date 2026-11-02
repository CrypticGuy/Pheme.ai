// Sign-up / register / rotate flow against a running Supabase stack (local by default).
//   Local:  npm run smoke:auth                       (email confirmation is off locally)
//   Hosted: PHEME_SUPABASE_URL=https://<ref>.supabase.co PHEME_SUPABASE_SERVICE_ROLE_KEY=... npm run smoke:auth
// With a service-role key set, test users are created pre-confirmed through the admin API (no emails are sent)
// and every row this script created is deleted at the end.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { account, bootstrap, signIn, signUp } from './auth-client.js';
import { BrokerClient, ApiError } from './client.js';

const api = (process.env.PHEME_SUPABASE_URL ?? 'http://127.0.0.1:55321').replace(/\/+$/, ''), url = `${api}/functions/v1/pheme`;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 })}`;
const explicitKey = process.env.PHEME_SUPABASE_SERVICE_ROLE_KEY;
const serviceKey = explicitKey ?? `${unsigned}.${createHmac('sha256', 'super-secret-jwt-token-with-at-least-32-characters-long').update(unsigned).digest('base64url')}`;
const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
async function invite() {
  const code = randomBytes(16).toString('base64url');
  const res = await fetch(`${api}/rest/v1/rpc/pheme_create_invite`, { method: 'POST', headers: admin, body: JSON.stringify({ p_hash: createHash('sha256').update(code).digest('hex'), p_note: 'smoke' }) });
  assert.ok(res.ok, await res.text()); return code;
}
const fails = (status: number) => (err: unknown) => err instanceof ApiError ? err.status === status : false;

const sfx = randomBytes(3).toString('hex'), password = 'smoke-test-password';
process.env.PHEME_SUPABASE_URL = api;
const e = await bootstrap(url);
const cfg = { url, ...e };
const authUsers: string[] = [], handles = [`alice${sfx}`, `bob${sfx}`, `alice2${sfx}`];
const session = async (n: string) => {
  const email = `${n}-${sfx}@example.com`;
  if (explicitKey) {
    const res = await fetch(`${api}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) });
    const created = await res.json() as { id: string };
    assert.ok(res.ok, `admin create user: ${JSON.stringify(created)}`); authUsers.push(created.id);
  } else assert.ok(await signUp(e, email, password), 'Signup returned no session (is email confirmation on?)');
  return (await signIn(e, email, password)).accessToken;
};

async function cleanup() {
  const rest = async (table: string, filter: string) => {
    const res = await fetch(`${api}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: admin });
    if (!res.ok) console.error(`cleanup ${table}: ${await res.text()}`);
  };
  const list = `in.(${handles.join(',')})`;
  await rest('pheme_events', `inbox=${list}`);
  await rest('pheme_reviews', `owner=${list}`);
  await rest('pheme_keys', `scoped_key=like.*${sfx}*`);
  await rest('pheme_invites', `used_by=${list}`);
  await rest('pheme_invites', 'note=eq.smoke&used_at=is.null');
  await rest('pheme_users', `id=${list}`);
  for (const id of authUsers) await fetch(`${api}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: admin });
}

try {
  const aliceJwt = await session('alice'), bobJwt = await session('bob');
  await assert.rejects(account(cfg, aliceJwt, 'GET', '/me'), /register first/);
  await assert.rejects(account(cfg, aliceJwt, 'POST', '/register', { handle: `alice${sfx}`, name: 'Alice', invite: 'not-a-real-invite-code' }), /invalid or already used/i);
  const code = await invite();
  const alice = await account<{ id: string; token: string }>(cfg, aliceJwt, 'POST', '/register', { handle: `alice${sfx}`, name: 'Alice', invite: code });
  await assert.rejects(account(cfg, bobJwt, 'POST', '/register', { handle: `bob${sfx}`, name: 'Bob', invite: code }), /invalid or already used/i);
  await assert.rejects(account(cfg, aliceJwt, 'POST', '/register', { handle: `alice2${sfx}`, name: 'Alice', invite: await invite() }), /already registered/);
  const bob = await account<{ id: string; token: string }>(cfg, bobJwt, 'POST', '/register', { handle: `bob${sfx}`, name: 'Bob', invite: await invite() });
  assert.equal((await account<{ id: string }>(cfg, aliceJwt, 'GET', '/me')).id, alice.id);
  await assert.rejects(account(cfg, 'garbage', 'GET', '/me'), /expired|invalid/i);
  // A Pheme bridge token must not work as an account session, and vice versa.
  await assert.rejects(account(cfg, alice.token, 'GET', '/me'), /expired|invalid/i);
  await assert.rejects(new BrokerClient(url, aliceJwt).call('/reviews'), fails(401));

  const a = new BrokerClient(url, alice.token), b = new BrokerClient(url, bob.token);
  const review = await a.call<{ id: string }>('/reviews', { recipient: bob.id, title: 't', text: 'x' });
  assert.equal((await b.call<{ events: unknown[] }>('/inbox/events')).events.length, 1);
  assert.equal((await b.call<{ id: string }>(`/reviews/${review.id}`)).id, review.id);

  const rotated = await account<{ token: string }>(cfg, aliceJwt, 'POST', '/token/rotate');
  await assert.rejects(a.call('/reviews'), fails(401));
  assert.equal((await new BrokerClient(url, rotated.token).call<{ reviews: unknown[] }>('/reviews')).reviews.length, 1);
  console.log('auth smoke test passed');
} finally {
  if (explicitKey || api.includes('127.0.0.1')) await cleanup();
}
