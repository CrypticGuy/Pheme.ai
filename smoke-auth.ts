// API-level checks of sign-up, the email allowlist, registration, connections and token rotation.
//   Local:  npm run smoke:auth        Hosted: see testkit.ts
import assert from 'node:assert/strict';
import { account, bootstrap, signIn, signUp } from './auth-client.js';
import { BrokerClient, ApiError } from './client.js';
import { adminUser, allow, api, cleanup, handles, sfx, url } from './testkit.js';

process.env.PHEME_SUPABASE_URL = api;
const password = 'smoke-test-password', e = await bootstrap(url), cfg = { url, ...e };
const fails = (status: number) => (err: unknown) => err instanceof ApiError ? err.status === status : false;
const who = (n: string) => ({ email: `${n}-${sfx}@example.com`, handle: `${n}${sfx}` });
const [alice, bob, carol, mallory] = ['alice', 'bob', 'carol', 'mallory'].map(who);
handles.push(alice.handle, bob.handle, carol.handle, mallory.handle);
const login = async (p: { email: string }) => {
  if (!(await adminUser(p.email, password))) assert.ok(await signUp(e, p.email, password), 'Signup returned no session (is email confirmation on?)');
  return (await signIn(e, p.email, password)).accessToken;
};
const register = (jwt: string, p: { handle: string }) => account<{ id: string; token: string }>(cfg, jwt, 'POST', '/register', { handle: p.handle, name: p.handle });

try {
  const jwt = { alice: await login(alice), bob: await login(bob), carol: await login(carol), mallory: await login(mallory) };
  await assert.rejects(account(cfg, jwt.alice, 'GET', '/me'), /register first/);
  // Not on the allowlist: no handle, however valid the login.
  await assert.rejects(register(jwt.mallory, mallory), /not been invited/i);
  await allow(alice.email); await allow(bob.email, [alice.handle]); await allow(carol.email);
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
  // bob was pre-connected to alice by the allowlist entry; carol has no connections.
  assert.deepEqual((await A.call<any>('/people')).people.map((p: any) => p.id), [bob.handle]);
  assert.deepEqual((await B.call<any>('/people')).people.map((p: any) => p.id), [alice.handle]);
  assert.deepEqual((await C.call<any>('/people')).people, []);
  await assert.rejects(C.call('/reviews', { recipient: alice.handle, title: 't', text: 'x' }), fails(404));
  await assert.rejects(A.call('/reviews', { recipient: carol.handle, title: 't', text: 'x' }), fails(404));
  await assert.rejects(A.call('/reviews', { recipient: 'nobody-here', title: 't', text: 'x' }), fails(404));
  const review = await A.call<{ id: string }>('/reviews', { recipient: bob.handle, title: 't', text: 'x' });
  assert.equal((await B.call<{ events: unknown[] }>('/inbox/events')).events.length, 1);
  assert.equal((await B.call<{ id: string }>(`/reviews/${review.id}`)).id, review.id);

  const rotated = await account<{ token: string }>(cfg, jwt.alice, 'POST', '/token/rotate');
  await assert.rejects(A.call('/reviews'), fails(401));
  assert.equal((await new BrokerClient(url, rotated.token).call<{ reviews: unknown[] }>('/reviews')).reviews.length, 1);
  console.log('auth smoke test passed');
} finally { await cleanup(); }
