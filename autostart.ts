// Starting the desktop daemon at login: a Run-key entry on Windows, a LaunchAgent on macOS. No admin rights needed.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath } from './config.js';
import { isAlive, pidFile, readPid } from './desktop.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LABEL = 'ai.pheme.daemon';
const cliPath = () => join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const vbsPath = () => join(dirname(configPath()), 'daemon.vbs');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const autostartSupported = () => process.platform === 'win32' || process.platform === 'darwin';

export function installAutostart() {
  if (process.platform === 'win32') {
    // A .vbs launcher runs the daemon with no console window.
    const q = (s: string) => `""${s}""`;
    mkdirSync(dirname(vbsPath()), { recursive: true, mode: 0o700 });
    writeFileSync(vbsPath(), `CreateObject("WScript.Shell").Run "${q(process.execPath)} ${q(cliPath())} daemon run", 0, False\r\n`);
    execFileSync('reg', ['add', RUN_KEY, '/v', 'Pheme', '/t', 'REG_SZ', '/d', `wscript.exe //B "${vbsPath()}"`, '/f'], { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    const args = [process.execPath, cliPath(), 'daemon', 'run'].map(a => `    <string>${xml(a)}</string>`).join('\n');
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
`);
    const domain = `gui/${process.getuid!()}`;
    try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
    execFileSync('launchctl', ['bootstrap', domain, plistPath()], { stdio: 'ignore' });
  } else throw new Error('Desktop mode supports Windows and macOS');
}

export function removeAutostart() {
  if (process.platform === 'win32') {
    try { execFileSync('reg', ['delete', RUN_KEY, '/v', 'Pheme', '/f'], { stdio: 'ignore' }); } catch { /* not set */ }
    rmSync(vbsPath(), { force: true });
  } else if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    rmSync(plistPath(), { force: true });
  }
}

export function autostartInstalled() {
  if (process.platform === 'win32') { try { execFileSync('reg', ['query', RUN_KEY, '/v', 'Pheme'], { stdio: 'ignore' }); return true; } catch { return false; } }
  if (process.platform === 'darwin') return existsSync(plistPath());
  return false;
}

export function daemonRunning() { const pid = readPid(); return isAlive(pid) ? pid : undefined; }

export function startDaemon(): 'started' | 'already running' {
  if (daemonRunning()) return 'already running';
  spawn(process.execPath, [cliPath(), 'daemon', 'run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return 'started';
}

export function stopDaemon(): boolean {
  const pid = daemonRunning();
  if (!pid) return false;
  try { process.kill(pid); } catch { return false; }
  rmSync(pidFile(), { force: true });
  return true;
}
