#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { account, bootstrap, liveSession, signIn, signOut, signUp } from './auth-client.js';
import { configPath, loadConfig, saveConfig, type Saved } from './config.js';

const usage = `Pheme account CLI

  pheme signup   [--url URL] [--email E]             create a login (password is prompted)
  pheme login    [--url URL] [--email E]             log in to an existing account
  pheme register [--handle H] [--name N] [--invite CODE]
                                                     claim your Pheme handle and get a bridge token
  pheme setup    [--dir DIR]                         write .mcp.json for Claude Code in DIR (default: cwd)
  pheme whoami                                       show your login and handle
  pheme rotate                                       replace your bridge token (old one stops working)
  pheme logout                                       forget the login on this machine

Non-interactive: set PHEME_PASSWORD, and pass --email/--handle/--name/--invite.
URL is your Pheme function URL, e.g. https://<ref>.supabase.co/functions/v1/pheme (or set PHEME_URL).
State is kept in ${configPath()}`;

function flags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) throw new Error(`Unexpected argument: ${args[i]}`);
    out[m[1]] = m[2] ?? args[++i] ?? '';
    if (out[m[1]] === '' ) throw new Error(`--${m[1]} needs a value`);
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

async function signup(f: Record<string, string>) {
  const cfg = await target(f), email = await need(f.email, 'Email: ');
  const session = await signUp({ supabaseUrl: cfg.supabaseUrl!, anonKey: cfg.anonKey! }, email, await password(true));
  if (!session) { saveConfig(cfg); console.log(`Check ${email} for a confirmation link, click it, then run: pheme login`); return; }
  saveConfig({ ...cfg, session }); console.log(`Signed up as ${email}. Next: pheme register`);
}
async function login(f: Record<string, string>) {
  const cfg = await target(f), email = await need(f.email, 'Email: ');
  const session = await signIn({ supabaseUrl: cfg.supabaseUrl!, anonKey: cfg.anonKey! }, email, await password(false));
  saveConfig({ ...cfg, session }); console.log(`Logged in as ${session.email}.${cfg.handle ? ` Handle: ${cfg.handle}` : ' Next: pheme register'}`);
}
async function register(f: Record<string, string>) {
  const { cfg, token: jwt } = await liveSession();
  if (cfg.token && cfg.handle) throw new Error(`Already registered as "${cfg.handle}". Use "pheme rotate" for a new token.`);
  const handle = await need(f.handle, 'Handle (letters, digits, _ or -): '), name = f.name || (await ask(`Display name [${handle}]: `)) || handle;
  const invite = await need(f.invite, 'Invite code: ');
  const r = await account<{ id: string; name: string; token: string }>(cfg, jwt, 'POST', '/register', { handle, name, invite });
  saveConfig({ ...cfg, handle: r.id, name: r.name, token: r.token });
  console.log(`Registered "${r.id}". Your bridge token is stored in ${configPath()}.\nNext: pheme setup`);
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
  console.log(`Wrote ${file}.\nLaunch Claude from that folder with:\n  MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:pheme`);
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
  if (cfg.session && cfg.supabaseUrl && cfg.anonKey) await signOut({ supabaseUrl: cfg.supabaseUrl, anonKey: cfg.anonKey }, cfg.session);
  const { session: _s, ...rest } = cfg; saveConfig(rest);
  console.log('Logged out. Your bridge token stays stored so Claude keeps working; delete the config file to remove it.');
}

const [command, ...rest] = process.argv.slice(2);
try {
  const f = flags(rest);
  if (command === 'signup') await signup(f);
  else if (command === 'login') await login(f);
  else if (command === 'register') await register(f);
  else if (command === 'setup') setup(f);
  else if (command === 'whoami') await whoami();
  else if (command === 'rotate') await rotate();
  else if (command === 'logout') await logout();
  else { console.log(usage); process.exitCode = command && command !== 'help' && command !== '--help' ? 1 : 0; }
} catch (err) { console.error(`Error: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
