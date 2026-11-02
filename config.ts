import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Session = { accessToken: string; refreshToken: string; expiresAt: number; email: string };
export type Saved = { url?: string; supabaseUrl?: string; anonKey?: string; session?: Session; handle?: string; name?: string; token?: string; mode?: 'channel' | 'desktop' };

// Holds the Auth session and the bridge token. Keep it private; override the location with PHEME_HOME.
export const configPath = () => join(process.env.PHEME_HOME ?? join(homedir(), '.pheme'), 'config.json');

export function loadConfig(): Saved {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')) as Saved; } catch { return {}; }
}
export function saveConfig(value: Saved) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort; Windows ignores POSIX modes */ }
}
