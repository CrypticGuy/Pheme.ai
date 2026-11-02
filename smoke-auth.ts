// API-level checks of sign-up, registration, connect-by-email, review gating and token rotation.
//   Local:  npm run smoke:auth        Hosted: see testkit.ts
import assert from 'node:assert/strict';
import { account, bootstrap, signIn, signUp } from './auth-client.js';
import { BrokerClient, ApiError } from './client.js';
import { adminUser, api, cleanup, handles, sfx, url } from './testkit.js';

process.env.PHEME_SUPABASE_URL = api;
const password = 'smoke-test-password', e = await bootstrap(url), cfg = { url, ...e };
const fails = (status: number) => (err: unknown) => err instanceof ApiError ? err.status === status : false;
const who = (n: string) => ({ email: `${n}-${sfx}@example.com`, handle: `${n}${sfx}` });
const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map(who);
handles.push(alice.handle, bob.handle, carol.handle, dave.handle);
const login = async (p: { email: string }) => {
  if (!(await adminUser(p.email, password))) assert.ok(await signUp(e, p.email, password), 'Signup returned no session (is email confirmation on?)');
  return (await signIn(e, p.email, password)).accessToken;
};
const register = (jwt: string, p: { handle: string }) => account<{ id: string; token: string }>(cfg, jwt, 'POST', '/register', { handle: p.handle, name: p.handle });
const ids = async (c: BrokerClient) => (await c.call<any>('/people')).people.map((p: any) => p.id).sort();

try {
  const jwt = { alice: await login(alice), bob: await login(bob), carol: await login(carol), dave: await login(dave) };
  await assert.rejects(account(cfg, jwt.alice, 'GET', '/me'), /register first/);
  await assert.rejects(account(cfg, jwt.alice, 'POST', '/register', { handle: 'bad handle!', name: 'x' }), /Handle must be|invalid/i);
  const a = await register(jwt.alice, alice);
  await assert.rejects(register(jwt.alice, { handle: `${alice.handle}2` }), /already registered/);
  await assert.rejects(account(cfg, jwt.carol, 'POST', '/register', { handle: alice.handle, name: 'x' }), /taken/);
  const b = await register(jwt.bob, bob), c = await register(jwt.carol, carol);
  assert.equal((await account<{ id: string }>(cfg, jwt.alice, 'GET', '/me')).id, alice.handle);
  await assert.rejects(account(cfg, 'garbage', 'GET', '/me'), /expired|invalid/i);
  // Bridge tokens and account sessions are not interchangeable.
  await assert.rejects(account(cfg, a.token, 'GET', '/me'), /expired|invalid/i);
  await assert.rejects(new BrokerClient(url, jwt.alice).call('/reviews'), fails(401));

  const A = new BrokerClient(url, a.token), B = new BrokerClient(url, b.token), C = new BrokerClient(url, c.token);
  // Nobody is connected until they ask: messaging is blocked and the directory is empty.
  assert.deepEqual(await ids(A), []);
  await assert.rejects(A.call('/reviews', { recipient: bob.handle, title: 't', text: 'x' }), fails(404));
  await assert.rejects(A.call('/reviews', { recipient: 'nobody-here', title: 't', text: 'x' }), fails(404));

  // Connect by email: an existing member connects immediately, in both directions.
  assert.deepEqual(await A.call('/connect', { email: bob.email.toUpperCase() }), { requested: true });
  assert.deepEqual(await ids(A), [bob.handle]); assert.deepEqual(await ids(B), [alice.handle]); assert.deepEqual(await ids(C), []);
  await assert.rejects(A.call('/connect', { email: alice.email }), fails(400));
  await assert.rejects(A.call('/connect', { email: 'not-an-email' }), fails(400));
  await assert.rejects(C.call('/reviews', { recipient: alice.handle, title: 't', text: 'x' }), fails(404));
  const review = await A.call<{ id: string }>('/reviews', { recipient: bob.handle, title: 't', text: 'x' });
  assert.equal((await B.call<{ events: unknown[] }>('/inbox/events')).events.length, 1);
  assert.equal((await B.call<{ id: string }>(`/reviews/${review.id}`)).id, review.id);

  // The reply is identical for an unregistered address, which stays pending until that person joins.
  assert.deepEqual(await A.call('/connect', { email: `ghost-${sfx}@example.com` }), { requested: true });
  assert.deepEqual((await A.call<any>('/connections')).pending, [`ghost-${sfx}@example.com`]);
  assert.deepEqual(await C.call('/connect', { email: dave.email }), { requested: true });
  assert.deepEqual((await C.call<any>('/connections')).pending, [dave.email]);
  const d = await register(jwt.dave, dave);
  assert.deepEqual((await C.call<any>('/connections')).pending, []);
  assert.deepEqual(await ids(C), [dave.handle]);
  assert.deepEqual(await ids(new BrokerClient(url, d.token)), [carol.handle]);

  const rotated = await account<{ token: string }>(cfg, jwt.alice, 'POST', '/token/rotate');
  await assert.rejects(A.call('/reviews'), fails(401));
  assert.equal((await new BrokerClient(url, rotated.token).call<{ reviews: unknown[] }>('/reviews')).reviews.length, 1);
  console.log('auth smoke test passed');
} finally { await cleanup(); }
