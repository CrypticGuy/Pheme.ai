// Admin: create a single-use invite code. Needs the project service-role key; never give it to users.
//   PHEME_SUPABASE_URL=https://<ref>.supabase.co PHEME_SUPABASE_SERVICE_ROLE_KEY=... npm run invite -- "for Bob"
import { createHash, randomBytes } from 'node:crypto';
const url = process.env.PHEME_SUPABASE_URL, key = process.env.PHEME_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set PHEME_SUPABASE_URL and PHEME_SUPABASE_SERVICE_ROLE_KEY');
const code = randomBytes(16).toString('base64url');
const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/pheme_create_invite`, {
  method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_hash: createHash('sha256').update(code).digest('hex'), p_note: process.argv.slice(2).join(' ') || null })
});
if (!res.ok) throw new Error(`Invite failed: ${(await res.json() as { message?: string }).message ?? res.status}`);
console.log(code);
