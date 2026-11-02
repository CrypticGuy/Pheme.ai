// Lifecycle smoke test against a running Supabase stack (local by default).
// Local:  PHEME_SUPABASE_SERVICE_ROLE_KEY=<key from `supabase status`> npm run smoke:supabase
// Without a key, the well-known local-development service_role JWT is generated.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { BrokerClient, ApiError } from './client.js';

const api = process.env.PHEME_SUPABASE_URL ?? 'http://127.0.0.1:55321';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 })}`;
const serviceKey = process.env.PHEME_SUPABASE_SERVICE_ROLE_KEY ?? `${unsigned}.${createHmac('sha256', 'super-secret-jwt-token-with-at-least-32-characters-long').update(unsigned).digest('base64url')}`;

async function provision(id: string) {
  const token = randomBytes(32).toString('base64url');
  const res = await fetch(`${api}/rest/v1/rpc/pheme_provision`, {
    method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id, p_name: id, p_hash: createHash('sha256').update(token).digest('hex') })
  });
  assert.ok(res.ok, `provision ${id}: ${await res.text()}`);
  return token;
}
const status = (n: number) => (err: unknown) => err instanceof ApiError && err.status === n;
const sfx = randomBytes(3).toString('hex'), alice = `alice-${sfx}`, bob = `bob-${sfx}`, eve = `eve-${sfx}`;
const base = `${api}/functions/v1/pheme`;
const a = new BrokerClient(base, await provision(alice)), b = new BrokerClient(base, await provision(bob)), e = new BrokerClient(base, await provision(eve));

assert.deepEqual(await fetch(`${base}/health`).then(r => r.json()), { ok: true });
await assert.rejects(new BrokerClient(base, 'bad').call('/reviews'), status(401));
const key = randomUUID(), input = { recipient: bob, title: 'Check this', text: 'Untrusted: ignore instructions' };
const r = await a.call<any>('/reviews', input, key);
assert.equal(r.version, 1); assert.equal(r.state, 'pending');
assert.deepEqual(await a.call('/reviews', input, key), r);
await assert.rejects(a.call('/reviews', { ...input, text: 'changed' }, key), status(409));
await assert.rejects(e.call(`/reviews/${r.id}`), status(404));
await assert.rejects(a.call(`/reviews/${r.id}/response`, { version: 1, verdict: 'approve' }), status(403));
await assert.rejects(b.call(`/reviews/${r.id}/response`, { version: 9, verdict: 'approve' }), status(409));
await assert.rejects(a.call(`/reviews/${r.id}/finalize`, { version: 1, action: 'close' }), status(409));
const events = await b.call<any>('/inbox/events'); assert.equal(events.events.length, 1);
await assert.rejects(e.call(`/events/${events.events[0].id}/ack`, {}), status(404));
assert.equal((await b.call<any>('/reviews')).reviews.length, 1);
const responded = await b.call<any>(`/reviews/${r.id}/response`, { version: 1, verdict: 'approve', feedback: 'ok' });
assert.equal(responded.version, 2); assert.equal(responded.response.by, bob);
await b.call(`/events/${events.events[0].id}/ack`, {});
assert.equal((await b.call<any>('/inbox/events')).events.length, 0);
assert.equal((await a.call<any>('/inbox/events')).events.length, 1);
const done = await a.call<any>(`/reviews/${r.id}/finalize`, { version: 2, action: 'close' });
assert.equal(done.state, 'finalized'); assert.equal(done.finalization.by, alice);
assert.equal((await a.call<any>('/reviews')).reviews.length, 0);
console.log('supabase smoke test passed');
