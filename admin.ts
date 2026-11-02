// Admin tool (service-role key required; never give that key to users).
// People normally connect themselves with `pheme connect <email>`; this is for fixing things by hand.
//   npm run admin -- connect alice bob     connect two registered people
//   npm run admin -- people                list registered people, connections and pending requests
//   npm run admin -- adduser <email>       create an already-confirmed login (skips the confirmation email)
import { randomBytes } from 'node:crypto';
const url = process.env.PHEME_SUPABASE_URL?.replace(/\/+$/, ''), key = process.env.PHEME_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set PHEME_SUPABASE_URL and PHEME_SUPABASE_SERVICE_ROLE_KEY');
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function rpc(fn: string, args: object) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const value = await res.json() as { message?: string };
  if (!res.ok) throw new Error((value.message ?? String(res.status)).replace(/^pheme:\d+:/, ''));
  return value;
}
const get = async (path: string) => (await fetch(`${url}/rest/v1/${path}`, { headers })).json() as Promise<any[]>;
const [command, ...rest] = process.argv.slice(2);
if (command === 'connect') {
  const [x, y] = rest; if (!x || !y) throw new Error('Usage: connect <handle> <handle>');
  await rpc('pheme_connect', { p_x: x, p_y: y }); console.log(`${x} and ${y} are connected.`);
} else if (command === 'people') {
  const users = await get('pheme_users?select=id,name,email&order=id'), links = await get('pheme_connections?select=a,b&order=a');
  console.log('People:\n' + users.map(u => `  ${u.id} (${u.name})${u.email ? ` <${u.email}>` : ''}`).join('\n'));
  console.log('Connections:\n' + (links.map(l => `  ${l.a} <-> ${l.b}`).join('\n') || '  none'));
  const pending = await get('pheme_pending_connections?select=requester,email&order=requester');
  if (pending.length) console.log('Waiting for the other person to join:\n' + pending.map(p => `  ${p.requester} -> ${p.email}`).join('\n'));
} else if (command === 'adduser') {
  // Pre-confirmed login, for when the hosted project's confirmation-email limit is hit. The person then runs `pheme join <url>` with this email and password.
  const [email] = rest; if (!email) throw new Error('Usage: adduser <email>   (optional PHEME_TEMP_PASSWORD, otherwise one is generated)');
  const password = process.env.PHEME_TEMP_PASSWORD ?? randomBytes(9).toString('base64url');
  const res = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email: email.trim().toLowerCase(), password, email_confirm: true }) });
  const value = await res.json() as { msg?: string; message?: string };
  if (!res.ok && /already been registered/i.test(value.msg ?? value.message ?? '')) {
    // Signed up earlier but never confirmed: confirm it and keep their own password.
    const { users } = await (await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers })).json() as { users: { id: string; email: string }[] };
    const existing = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!existing) throw new Error('Account exists but could not be found; confirm it in the Supabase dashboard');
    const upd = await fetch(`${url}/auth/v1/admin/users/${existing.id}`, { method: 'PUT', headers, body: JSON.stringify({ email_confirm: true }) });
    if (!upd.ok) throw new Error(`Could not confirm existing login (${upd.status})`);
    console.log(`${existing.email} already had a login; it is now confirmed. They run: pheme join <url> with the password they signed up with.`);
  } else if (!res.ok) throw new Error(value.msg ?? value.message ?? String(res.status));
  else console.log(`Created confirmed login for ${email.trim().toLowerCase()}.\nTemporary password: ${password}\nThey run: pheme join <url>   (email + this password), then pick a handle.`);
} else throw new Error('Commands: connect <handle> <handle> | people | adduser <email>');
