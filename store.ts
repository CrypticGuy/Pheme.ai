import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type Review = { id: string; owner: string; recipient: string; title: string; text: string; version: number; createdAt: string; state: 'pending' | 'responded' | 'finalized'; response?: { by: string; at: string; verdict: string; feedback?: string }; finalization?: { by: string; at: string; action: string; note?: string } };
export type InboxEvent = { id: string; inbox: string; reviewId: string; kind: string; acked: boolean };
type State = { users: { id: string; name: string; tokenHash: string }[]; reviews: Review[]; events: InboxEvent[]; keys: Record<string, { fingerprint: string; result: Review }> };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class Store {
  private db: DatabaseSync;
  private state: State = { users: [], reviews: [], events: [], keys: {} };
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)');
    this.refresh();
  }
  close() { this.db.close(); }
  private refresh() {
    const row = this.db.prepare('SELECT json FROM state WHERE id=1').get() as { json: string } | undefined;
    if (row) this.state = JSON.parse(row.json);
  }
  private mutate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE'); this.refresh(); const before = structuredClone(this.state);
    try {
      const result = fn();
      this.db.prepare('INSERT INTO state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(this.state));
      this.db.exec('COMMIT'); return structuredClone(result);
    } catch (err) { this.state = before; this.db.exec('ROLLBACK'); throw err; }
  }
  provision(id: string, name: string) {
    return this.mutate(() => {
      if (this.state.users.some(u => u.id === id)) throw new HttpError(409, 'User already exists');
      const token = randomBytes(32).toString('base64url'); this.state.users.push({ id, name, tokenHash: hash(token) }); return { id, name, token };
    });
  }
  authenticate(token: string) { this.refresh(); const user = this.state.users.find(u => u.tokenHash === hash(token)); if (!user) throw new HttpError(401, 'Invalid bearer token'); return { ...user }; }
  getReview(id: string, user: string): Review {
    this.refresh(); const r = this.state.reviews.find(r => r.id === id);
    if (!r || (r.owner !== user && r.recipient !== user)) throw new HttpError(404, 'Review not found'); return structuredClone(r);
  }
  pending(user: string) { this.refresh(); return structuredClone(this.state.reviews.filter(r => (r.owner === user || r.recipient === user) && r.state !== 'finalized')); }
  events(user: string) { this.refresh(); return structuredClone(this.state.events.filter(e => e.inbox === user && !e.acked)); }
  private event(inbox: string, reviewId: string, kind: string) { this.state.events.push({ id: randomUUID(), inbox, reviewId, kind, acked: false }); }
  ack(id: string, user: string) {
    return this.mutate(() => { const e = this.state.events.find(e => e.id === id && e.inbox === user); if (!e) throw new HttpError(404, 'Event not found'); e.acked = true; return { acknowledged: true }; });
  }
  private change(user: string, key: string, op: string, payload: unknown, fn: () => Review): Review {
    return this.mutate(() => {
      const scoped = `${user}:${key}`, fingerprint = hash(JSON.stringify({ op, payload })), old = this.state.keys[scoped];
      if (old) { if (old.fingerprint !== fingerprint) throw new HttpError(409, 'Idempotency key reused'); return old.result; }
      const result = fn(); this.state.keys[scoped] = { fingerprint, result: structuredClone(result) }; return result;
    });
  }
  create(user: string, key: string, data: { recipient: string; title: string; text: string }) {
    return this.change(user, key, 'create', data, () => {
      if (!this.state.users.some(u => u.id === data.recipient)) throw new HttpError(404, 'Recipient not found');
      if (user === data.recipient) throw new HttpError(400, 'Choose a different reviewer');
      const r: Review = { id: randomUUID(), owner: user, ...data, version: 1, state: 'pending', createdAt: new Date().toISOString() };
      this.state.reviews.push(r); this.event(data.recipient, r.id, 'review_requested'); return r;
    });
  }
  respond(user: string, key: string, id: string, data: { version: number; verdict: string; feedback?: string }) {
    return this.change(user, key, `respond:${id}`, data, () => {
      const r = this.state.reviews.find(r => r.id === id);
      if (!r || r.recipient !== user) throw new HttpError(403, 'Only designated reviewer can respond');
      if (r.version !== data.version || r.state !== 'pending') throw new HttpError(409, 'Review changed; reload');
      r.response = { by: user, at: new Date().toISOString(), verdict: data.verdict, ...(data.feedback === undefined ? {} : { feedback: data.feedback }) };
      r.state = 'responded'; r.version++; this.event(r.owner, id, 'review_responded'); return r;
    });
  }
  finalize(user: string, key: string, id: string, data: { version: number; action: string; note?: string }) {
    return this.change(user, key, `finalize:${id}`, data, () => {
      const r = this.state.reviews.find(r => r.id === id);
      if (!r || r.owner !== user) throw new HttpError(403, 'Only owner can finalize');
      if (r.version !== data.version || r.state !== 'responded') throw new HttpError(409, 'Response at expected version required');
      r.finalization = { by: user, at: new Date().toISOString(), action: data.action, ...(data.note === undefined ? {} : { note: data.note }) };
      r.state = 'finalized'; r.version++; return r;
    });
  }
}
