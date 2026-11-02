// Admin tool (service-role key required; never give that key to users).
//   npm run admin -- invite bob@example.com [--with alice,carol]   allow an email to join, optionally pre-connected
//   npm run admin -- connect alice bob                             let two registered people message each other
//   npm run admin -- people                                        list registered people and connections
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
if (command === 'invite') {
  const email = rest[0]?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: invite <email> [--with handle,handle]');
  const w = rest.indexOf('--with'), peers = w >= 0 ? (rest[w + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [];
  await rpc('pheme_allow_email', { p_email: email, p_connect_with: peers });
  console.log(`${email} may now join${peers.length ? ` and will be connected to: ${peers.join(', ')}` : ''}.\nThey run: npm run pheme -- join <pheme-url>`);
} else if (command === 'connect') {
  const [x, y] = rest; if (!x || !y) throw new Error('Usage: connect <handle> <handle>');
  await rpc('pheme_connect', { p_x: x, p_y: y }); console.log(`${x} and ${y} are connected.`);
} else if (command === 'people') {
  const users = await get('pheme_users?select=id,name&order=id'), links = await get('pheme_connections?select=a,b&order=a');
  console.log('People:\n' + users.map(u => `  ${u.id} (${u.name})`).join('\n') + '\nConnections:\n' + (links.map(l => `  ${l.a} <-> ${l.b}`).join('\n') || '  none'));
  const pending = await get('pheme_allowed_emails?select=email,connect_with&claimed_by=is.null');
  if (pending.length) console.log('Invited, not yet joined:\n' + pending.map(p => `  ${p.email}${p.connect_with.length ? ` (connects to ${p.connect_with.join(', ')})` : ''}`).join('\n'));
} else throw new Error('Commands: invite <email> [--with a,b] | connect <a> <b> | people');
