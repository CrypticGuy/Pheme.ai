#!/usr/bin/env node
// Launches Claude Code with the Pheme channel: registers the bridge once at user scope (so it works from any
// folder), sets legacy MCP protocol negotiation and loads the custom channel with the development flag.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig } from './config.js';

const usage = `claude-pheme [--register-only] [claude arguments...]

Starts Claude Code with the Pheme human-review channel loaded:
  MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:pheme [arguments]

The first run (and any run after the install path or server URL changes) registers the "pheme" MCP server
in your user-level Claude config, so no .mcp.json is needed. Run "pheme join <url>" first to get your token.
  --register-only   register the MCP server and exit without starting Claude`;

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') { console.log(usage); process.exit(0); }
const registerOnly = args[0] === '--register-only';
const passthrough = registerOnly ? args.slice(1) : args;

const cfg = loadConfig();
if (!cfg.url || !cfg.token) { console.error('Not registered yet. Run: pheme join <your Pheme URL>'); process.exit(1); }

// cmd.exe needs quoting for arguments with spaces (e.g. C:\Program Files\nodejs\node.exe).
const win = process.platform === 'win32';
const quote = (s: string) => (win && /[\s&|<>^"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const claude = (a: string[]) => spawnSync('claude', a.map(quote), { encoding: 'utf8', shell: win });
if (claude(['--version']).status !== 0) { console.error('Cannot run "claude". Install Claude Code first: https://code.claude.com/docs'); process.exit(1); }

const bridge = join(dirname(fileURLToPath(import.meta.url)), 'bridge.js');
const wanted = JSON.stringify({ node: process.execPath, bridge, url: cfg.url });
const marker = join(dirname(configPath()), 'claude-registration.json');
const current = (() => { try { return readFileSync(marker, 'utf8'); } catch { return ''; } })();

// The token is not copied into Claude's config; the bridge reads it from the private ~/.pheme config file.
if (current !== wanted || claude(['mcp', 'get', 'pheme']).status !== 0) {
  claude(['mcp', 'remove', 'pheme', '--scope', 'user']); // fine if it was not registered yet
  const added = claude(['mcp', 'add', '--scope', 'user', 'pheme', '--env', `PHEME_URL=${cfg.url}`, '--', process.execPath, bridge]);
  if (added.status !== 0) { console.error(`Could not register the Pheme MCP server:\n${added.stdout}${added.stderr}`); process.exit(1); }
  mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, wanted);
  console.error('Registered the "pheme" MCP server in your user-level Claude config.');
}
if (registerOnly) process.exit(0);

const child = spawn('claude', ['--dangerously-load-development-channels', 'server:pheme', ...passthrough].map(quote), {
  stdio: 'inherit', shell: win, env: { ...process.env, MCP_PROTOCOL_NEGOTIATION: 'legacy' }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', err => { console.error(`Failed to start claude: ${err.message}`); process.exit(1); });
