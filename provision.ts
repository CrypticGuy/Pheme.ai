import { createHash, randomBytes } from 'node:crypto';
import { Store } from './store.js';
const [id, ...name] = process.argv.slice(2);
if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Usage: npm run provision -- alice "Alice"');
const display = name.join(' ') || id;
const supabaseUrl = process.env.PHEME_SUPABASE_URL, serviceKey = process.env.PHEME_SUPABASE_SERVICE_ROLE_KEY;
if (supabaseUrl && serviceKey) {
  // Supabase mode: store only the token hash through the service-role-only RPC.
  const token = randomBytes(32).toString('base64url');
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/pheme_provision`, {
    method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id, p_name: display, p_hash: createHash('sha256').update(token).digest('hex') })
  });
  if (!res.ok) throw new Error(`Provision failed: ${(await res.json() as { message?: string }).message ?? res.status}`);
  console.log(JSON.stringify({ id, name: display, token }, null, 2));
} else {
  const store = new Store(process.env.PHEME_DB ?? 'data/pheme.sqlite');
  try { console.log(JSON.stringify(store.provision(id, display), null, 2)); } finally { store.close(); }
}
