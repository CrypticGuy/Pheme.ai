// The desktop daemon: watches the server for reviews and shows a native form instead of a Claude channel ping.
// It never acks inbox events (the bridge owns those); it lists reviews and remembers what it already showed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ApiError, BrokerClient } from './client.js';
import { configPath, loadConfig } from './config.js';
import { defaultPrompter, type Prompter } from './prompter.js';
import type { Review } from './store.js';

const answerSchema = z.object({ verdict: z.enum(['approve', 'request_changes', 'comment']), feedback: z.string().max(10_000).optional() }).strict();
const label = { approve: 'approval', request_changes: 'request for changes', comment: 'comment' } as const;
const plain = (s: string, n = 100) => { const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const home = () => dirname(configPath());
const seenFile = () => join(home(), 'desktop-seen.json');
export const pidFile = () => join(home(), 'daemon.pid');
const logFile = () => join(home(), 'daemon.log');
export function log(message: string) {
  try { mkdirSync(home(), { recursive: true, mode: 0o700 }); appendFileSync(logFile(), `${new Date().toISOString()} ${message}\n`); } catch { /* logging is best effort */ }
}

export function readPid(): number | undefined {
  try { const n = Number(readFileSync(pidFile(), 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : undefined; } catch { return undefined; }
}
export function isAlive(pid: number | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** What has already been shown, kept on disk so a restart does not repeat notifications. */
export class DesktopState {
  seen: Set<string>;
  snoozed = new Map<string, number>();
  /** True when there was no history: the first tick marks old replies as seen instead of announcing them all. */
  fresh: boolean;
  constructor(public snoozeMs = 60 * 60_000) {
    try { this.seen = new Set(JSON.parse(readFileSync(seenFile(), 'utf8')) as string[]); this.fresh = false; } catch { this.seen = new Set(); this.fresh = true; }
  }
  save() {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(seenFile(), JSON.stringify([...this.seen].slice(-500)));
  }
}

/** One pass: ask for verdicts on pending reviews, announce replies. Only a validated form answer is ever posted. */
export async function tick(client: BrokerClient, me: string, prompter: Prompter, state: DesktopState, now = Date.now(), note: (m: string) => void = log) {
  const { reviews } = await client.call<{ reviews: Review[] }>('/reviews');
  if (state.fresh) {
    for (const r of reviews) if (r.owner === me && r.state === 'responded') state.seen.add(`reply:${r.id}:${r.version}`);
    state.fresh = false; state.save();
  }
  for (const r of reviews) {
    if (r.recipient === me && r.state === 'pending') {
      const key = `ask:${r.id}:${r.version}`;
      if ((state.snoozed.get(key) ?? 0) > now) continue;
      const later = (ms = state.snoozeMs) => state.snoozed.set(key, now + ms);
      let raw: unknown;
      try { raw = await prompter.ask(r); } catch (err) { note(`form failed: ${err instanceof Error ? err.message : err}`); later(); continue; }
      if (raw === null) { later(); continue; }
      const answer = answerSchema.safeParse(raw);
      if (!answer.success) { note('ignored a malformed form answer'); later(); continue; }
      const { verdict, feedback } = answer.data;
      try {
        await client.call(`/reviews/${r.id}/response`, { version: r.version, verdict, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) });
        await prompter.notify('Pheme', `Sent your ${label[verdict]} to ${plain(r.owner, 40)}.`).catch(() => undefined);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) await prompter.notify('Pheme', 'That review was already answered or changed.').catch(() => undefined);
        else { note(`could not send answer: ${err instanceof Error ? err.message : err}`); await prompter.notify('Pheme', 'Could not send your answer. Will ask again shortly.').catch(() => undefined); later(60_000); }
      }
    } else if (r.owner === me && r.state === 'responded' && r.response) {
      const key = `reply:${r.id}:${r.version}`;
      if (state.seen.has(key)) continue;
      state.seen.add(key); state.save();
      await prompter.notify(`${plain(r.response.by, 40)} replied: ${r.response.verdict.replace('_', ' ')}`, `"${plain(r.title, 80)}". In Claude, ask to finalize review ${r.id.slice(0, 8)}.`).catch(err => note(`notify failed: ${err instanceof Error ? err.message : err}`));
    }
  }
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});

/** Runs until desktop mode is switched off or the process is stopped. Only one daemon runs per user. */
export async function runDaemon(prompter: Prompter = defaultPrompter(), intervalMs = 15_000) {
  if (loadConfig().mode !== 'desktop') { console.error('Desktop mode is off. Turn it on with: pheme mode desktop'); return; }
  const existing = readPid();
  if (existing && existing !== process.pid && isAlive(existing)) { console.error(`Pheme daemon is already running (pid ${existing}).`); return; }
  try { if (existsSync(logFile()) && statSync(logFile()).size > 256 * 1024) rmSync(logFile()); } catch { /* ignore */ }
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), String(process.pid));
  const stop = new AbortController(), state = new DesktopState();
  const quit = () => stop.abort();
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  log(`daemon started (pid ${process.pid})`);
  let client: BrokerClient | undefined, clientKey = '', delay = intervalMs, lastError = '';
  while (!stop.signal.aborted) {
    const cfg = loadConfig();
    if (cfg.mode !== 'desktop') { log('desktop mode switched off; exiting'); break; }
    if (cfg.url && cfg.token && cfg.handle) {
      try {
        if (!client || clientKey !== `${cfg.url}|${cfg.token}`) { client = new BrokerClient(cfg.url, cfg.token, stop.signal); clientKey = `${cfg.url}|${cfg.token}`; }
        await tick(client, cfg.handle, prompter, state);
        delay = intervalMs; lastError = '';
      } catch (err) {
        if (stop.signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastError) log(`poll failed: ${msg}`);
        lastError = msg; delay = Math.min(delay * 2, 120_000);
      }
    }
    await wait(delay, stop.signal);
  }
  try { if (readPid() === process.pid) rmSync(pidFile()); } catch { /* ignore */ }
  log('daemon stopped');
}
