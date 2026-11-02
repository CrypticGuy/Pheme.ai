import { Store } from './store.js';
const [id, ...name] = process.argv.slice(2);
if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Usage: npm run provision -- alice "Alice"');
const store = new Store(process.env.PHEME_DB ?? 'data/pheme.sqlite');
try { console.log(JSON.stringify(store.provision(id, name.join(' ') || id), null, 2)); } finally { store.close(); }
