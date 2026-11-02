#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { account, bootstrap, liveSession, signIn, signOut, signUp } from './auth-client.js';
import { BrokerClient } from './client.js';
import { configPath, loadConfig, saveConfig, type Saved, type Session } from './config.js';

const usage = `Pheme account CLI

  pheme join [URL] [--email E] [--handle H] [--name N] [--dir DIR]
      Everything in one step: sign up (or log in), wait for email confirmation, claim your
      handle, and write .mcp.json for Claude Code in DIR (default: current folder).

  pheme connect EMAIL           connect with someone so you can ask them for feedback; if they have not
                                joined yet, you are connected when they do
  pheme connections             list who you are connected with and who is still pending
  pheme whoami                  show your login and handle
  pheme rotate                  replace your bridge token (the old one stops working)
  pheme logout                  forget the login on this machine

Individual steps, if you need them: signup, login, register, setup.
Non-interactive: set PHEME_PASSWORD and pass --email/--handle/--name.
URL is your Pheme function URL, e.g. https://<ref>.supabase.co/functions/v1/pheme (or set PHEME_URL).
State is kept in ${configPath()}`;

function flags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    // npm swallows "--url" unless it comes after "--", so also accept the bare URL.
    if (/^https?:\/\//.test(args[i])) { out.url = args[i]; continue; }
    if (!args[i].startsWith('--')) continue; // positional (e.g. the email for "connect")
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) throw new Error(`Unexpected argument: ${args[i]}`);
    out[m[1]] = m[2] ?? args[++i] ?? '';
    if (out[m[1]] === '') throw new Error(`--${m[1]} needs a value`);
  }
  return out;
}
async function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`Cannot prompt for "${question.trim()}" without a terminal; pass it as a flag or env var`);
  const quiet = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: hidden ? quiet : process.stdout, terminal: true });
  try {
    if (hidden) process.stdout.write(question);
    const answer = (await rl.question(hidden ? '' : question)).trim();
    if (hidden) process.stdout.write('\n');
    return answer;
  } finally { rl.close(); }
}
const need = async (value: string | undefined, question: string) => value || (await ask(question)) || (() => { throw new Error(`${question.trim()} is required`); })();
async function password(confirm: boolean) {
  const fromEnv = process.env.PHEME_PASSWORD;
  if (fromEnv) return fromEnv;
  const pw = await ask('Password (min 8 characters): ', true);
  if (pw.length < 8) throw new Error('Password must be at least 8 characters');
  if (confirm && (await ask('Repeat password: ', true)) !== pw) throw new Error('Passwords do not match');
  return pw;
}
async function target(f: Record<string, string>): Promise<Saved> {
  const cfg = loadConfig(), url = (f.url ?? process.env.PHEME_URL ?? cfg.url ?? (await ask('Pheme URL: '))).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error('Pheme URL must start with http:// or https://');
  if (cfg.url === url && cfg.supabaseUrl && cfg.anonKey) return cfg;
  // A different server invalidates any saved session, handle and token.
  return { url, ...(await bootstrap(url)) };
}
const endpoint = (cfg: Saved) => ({ supabaseUrl: cfg.supabaseUrl!, anonKey: cfg.anonKey! });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function signup(f: Record<string, string>) {
  const cfg = await target(f), email = await need(f.email, 'Email: ');
  const session = await signUp(endpoint(cfg), email, await password(true));
  if (!session) { saveConfig(cfg); console.log(`Check ${email} for a confirmation link, click it, then run: pheme login`); return; }
  saveConfig({ ...cfg, session }); console.log(`Signed up as ${email}. Next: pheme register`);
}
async function login(f: Record<string, string>) {
  const cfg = await target(f), email = await need(f.email, 'Email: ');
  const session = await signIn(endpoint(cfg), email, await password(false));
  saveConfig({ ...cfg, session }); console.log(`Logged in as ${session.email}.${cfg.handle ? ` Handle: ${cfg.handle}` : ' Next: pheme register'}`);
}
async function register(f: Record<string, string>) {
  const { cfg, token: jwt } = await liveSession();
  if (cfg.token && cfg.handle) throw new Error(`Already registered as "${cfg.handle}". Use "pheme rotate" for a new token.`);
  const handle = await need(f.handle, 'Handle (letters, digits, _ or -): '), name = f.name || (await ask(`Display name [${handle}]: `)) || handle;
  const r = await account<{ id: string; name: string; token: string }>(cfg, jwt, 'POST', '/register', { handle, name }).catch(err => {
    throw new Error(/not been invited/.test(err.message) ? `${err.message}\nYour sign-in email is ${cfg.session!.email}.` : err.message);
  });
  saveConfig({ ...cfg, handle: r.id, name: r.name, token: r.token });
  console.log(`Registered "${r.id}". Your bridge token is stored in ${configPath()}.`);
}
function setup(f: Record<string, string>) {
  const cfg = loadConfig();
  if (!cfg.url || !cfg.token) throw new Error('Register first: pheme register');
  const file = join(resolve(f.dir ?? process.cwd()), '.mcp.json');
  let mcp: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) { try { mcp = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { throw new Error(`${file} is not valid JSON; fix or move it first`); } }
  // No secret goes into .mcp.json: the bridge reads the token from the private config file.
  mcp.mcpServers = { ...mcp.mcpServers, pheme: { type: 'stdio', command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), 'bridge.js')], env: { PHEME_URL: cfg.url } } };
  writeFileSync(file, JSON.stringify(mcp, null, 2) + '\n');
  console.log(`Wrote ${file}.`);
}

/** Sign in, creating the account first if needed. Waits for the confirmation email when the project requires it. */
async function establishSession(cfg: Saved, email: string, pw: string): Promise<Session> {
  const e = endpoint(cfg);
  try { return await signIn(e, email, pw); } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/not confirmed/i.test(msg)) return waitForConfirmation(e, email, pw);
    if (!/invalid login credentials/i.test(msg)) throw err;
  }
  // No such login (or a wrong password): try creating the account.
  const session = await signUp(e, email, pw);
  if (session) return session;
  return waitForConfirmation(e, email, pw, true);
}
async function waitForConfirmation(e: { supabaseUrl: string; anonKey: string }, email: string, pw: string, justSignedUp = false): Promise<Session> {
  console.log(`Check ${email} for a confirmation link and click it. Waiting (Ctrl+C to stop)...`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try { return await signIn(e, email, pw); } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/not confirmed/i.test(msg)) continue;
      // An unconfirmed account reports "not confirmed"; "invalid credentials" means the email already exists with another password.
      if (/invalid login credentials/i.test(msg)) { if (justSignedUp) throw new Error(`An account for ${email} already exists with a different password. Use that password, or reset it in Supabase Auth.`); continue; }
      throw err;
    }
  }
  throw new Error('Timed out waiting for email confirmation. Click the link, then run: pheme join again');
}

async function joinCommand(f: Record<string, string>) {
  let cfg = await target(f);
  const email = await need(f.email, 'Email: '), pw = await password(false);
  const session = await establishSession(cfg, email, pw);
  cfg = { ...cfg, session }; saveConfig(cfg);
  console.log(`Signed in as ${session.email}.`);
  const me = await account<{ id: string; name: string }>(cfg, session.accessToken, 'GET', '/me').catch(err => {
    if (/register first/i.test(err.message)) return null; throw err;
  });
  if (!me) { await register(f); }
  else if (!loadConfig().token) {
    // Registered on another machine: this one needs its own token (the old one stops working).
    const r = await account<{ id: string; name: string; token: string }>(cfg, session.accessToken, 'POST', '/token/rotate');
    saveConfig({ ...cfg, handle: r.id, name: r.name, token: r.token }); console.log(`Welcome back, ${r.id}. Issued a new token for this machine.`);
  } else console.log(`Already registered as "${me.id}".`);
  setup(f);
  console.log('\nDone. Run: claude-pheme   (install it once with "npm link" in the Pheme repo)\nOr launch Claude from that folder with:\n  MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:pheme\nConnect with people: pheme connect their@email\nThen ask it, for example: "get feedback on this plan from <name>".');
}
function broker() {
  const cfg = loadConfig();
  if (!cfg.url || !cfg.token) throw new Error('Not registered on this machine. Run: pheme join');
  return new BrokerClient(cfg.url, cfg.token);
}
async function connect(email: string | undefined) {
  const mail = (email ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Usage: pheme connect person@example.com');
  await broker().call('/connect', { email: mail });
  // The server does not reveal whether the address has an account, so neither do we.
  console.log(`Requested. You are connected with ${mail} once they have an account here (check: pheme connections).`);
}
async function connections() {
  const { people, pending } = await broker().call<{ people: { id: string; name: string }[]; pending: string[] }>('/connections');
  console.log(`Connected (${people.length}):\n${people.map(p => `  ${p.id} (${p.name})`).join('\n') || '  nobody yet'}`);
  if (pending.length) console.log(`Waiting for them to join:\n${pending.map(e => `  ${e}`).join('\n')}`);
}
async function whoami() {
  const { cfg, token } = await liveSession();
  const me = await account<{ id: string; name: string }>(cfg, token, 'GET', '/me').catch(() => null);
  console.log(`Login:  ${cfg.session!.email}\nServer: ${cfg.url}\nHandle: ${me ? `${me.id} (${me.name})` : 'not registered'}\nToken:  ${cfg.token ? 'stored' : 'none'}`);
}
async function rotate() {
  const { cfg, token: jwt } = await liveSession();
  const r = await account<{ id: string; token: string }>(cfg, jwt, 'POST', '/token/rotate');
  saveConfig({ ...cfg, handle: r.id, token: r.token });
  console.log('Token rotated and stored. Restart Claude so the bridge picks it up; the old token no longer works.');
}
async function logout() {
  const cfg = loadConfig();
  if (cfg.session && cfg.supabaseUrl && cfg.anonKey) await signOut(endpoint(cfg), cfg.session);
  const { session: _s, ...rest } = cfg; saveConfig(rest);
  console.log('Logged out. Your bridge token stays stored so Claude keeps working; delete the config file to remove it.');
}

const [command, ...rest] = process.argv.slice(2);
try {
  const f = flags(rest);
  if (command === 'join') await joinCommand(f);
  else if (command === 'signup') await signup(f);
  else if (command === 'login') await login(f);
  else if (command === 'register') { await register(f); console.log('Next: pheme setup'); }
  else if (command === 'setup') { setup(f); console.log('Launch Claude from that folder with:\n  MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:pheme'); }
  else if (command === 'connect') await connect(process.argv[3]);
  else if (command === 'connections') await connections();
  else if (command === 'whoami') await whoami();
  else if (command === 'rotate') await rotate();
  else if (command === 'logout') await logout();
  else { console.log(usage); process.exitCode = command && command !== 'help' && command !== '--help' ? 1 : 0; }
} catch (err) { console.error(`Error: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
