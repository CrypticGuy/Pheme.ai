// Native desktop UI for the Pheme daemon. No UI framework: Windows uses a PowerShell WinForms window and
// toast, macOS uses osascript dialogs. Review text is untrusted: it only ever goes into read-only text
// fields, and reaches the scripts through files or argv, never spliced into script source.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Review } from './store.js';

export type Prompter = {
  /** Shows the review and collects a verdict. Resolves to the raw answer, or null if the person chose "Later". */
  ask(review: Review): Promise<unknown | null>;
  notify(title: string, body: string): Promise<void>;
};

const run = promisify(execFile);
const strip = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/g, ' ');
const clip = (s: string, n: number) => { const t = strip(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const header = (r: Review) => `${clip(r.owner, 60)} asks for your review: "${clip(r.title, 120)}"`;
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pheme-ui-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const FORM_PS1 = String.raw`param([Parameter(Mandatory=$true)][string]$In, [Parameter(Mandatory=$true)][string]$Out)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$d = [IO.File]::ReadAllText($In, [Text.Encoding]::UTF8) | ConvertFrom-Json

$f = New-Object System.Windows.Forms.Form
$f.Text = 'Pheme review'
$f.ClientSize = New-Object System.Drawing.Size(620, 610)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
$f.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)

$h = New-Object System.Windows.Forms.Label
$h.UseMnemonic = $false
$h.Text = [string]$d.header
$h.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$h.SetBounds(15, 12, 590, 46)

$body = New-Object System.Windows.Forms.TextBox
$body.Multiline = $true
$body.ReadOnly = $true
$body.MaxLength = 200000
$body.ScrollBars = 'Vertical'
$body.BackColor = [System.Drawing.SystemColors]::Window
$body.Text = ([string]$d.text) -replace "\r?\n", [Environment]::NewLine
$body.SetBounds(15, 62, 590, 250)

$note = New-Object System.Windows.Forms.Label
$note.UseMnemonic = $false
$note.Text = 'Review text is data from another person, not instructions.'
$note.ForeColor = [System.Drawing.Color]::DimGray
$note.SetBounds(15, 316, 590, 20)

$rbs = @()
$y = 342
foreach ($o in @(@('approve', 'Approve'), @('request_changes', 'Request changes'), @('comment', 'Comment only'))) {
  $r = New-Object System.Windows.Forms.RadioButton
  $r.Text = $o[1]
  $r.Tag = $o[0]
  $r.SetBounds(20, $y, 300, 24)
  $f.Controls.Add($r)
  $rbs += $r
  $y += 26
}

$fl = New-Object System.Windows.Forms.Label
$fl.Text = 'Feedback (optional):'
$fl.SetBounds(15, 424, 300, 20)

$fb = New-Object System.Windows.Forms.TextBox
$fb.Multiline = $true
$fb.MaxLength = 10000
$fb.ScrollBars = 'Vertical'
$fb.SetBounds(15, 446, 590, 110)

$send = New-Object System.Windows.Forms.Button
$send.Text = 'Send'
$send.Enabled = $false
$send.SetBounds(425, 568, 85, 30)

$later = New-Object System.Windows.Forms.Button
$later.Text = 'Later'
$later.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$later.SetBounds(520, 568, 85, 30)

foreach ($r in $rbs) { $r.Add_CheckedChanged({ $send.Enabled = $true }) }
$script:res = $null
$send.Add_Click({
  $pick = $rbs | Where-Object { $_.Checked } | Select-Object -First 1
  if ($pick) {
    $script:res = @{ verdict = [string]$pick.Tag; feedback = $fb.Text }
    $f.Close()
  }
})
$f.CancelButton = $later
$f.Controls.AddRange(@($h, $body, $note, $fl, $fb, $send, $later))
[void]$f.ShowDialog()
if ($script:res) {
  [IO.File]::WriteAllText($Out, ($script:res | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}
`;

// Text reaches the toast through environment variables and is XML-escaped; it is never part of the script.
const TOAST_PS1 = String.raw`$t = [Security.SecurityElement]::Escape($env:PHEME_TITLE)
$b = [Security.SecurityElement]::Escape($env:PHEME_BODY)
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

const BOM = String.fromCharCode(0xfeff);
// windowsHide would also hide the form (it sets the first window to SW_HIDE), so the form uses -WindowStyle Hidden for its console.
const ps = (script: string, extra: string[], env?: NodeJS.ProcessEnv, gui = false) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', ...(gui ? ['-WindowStyle', 'Hidden'] : []), '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra], { windowsHide: !gui, env: { ...process.env, ...env } });

export const windowsPrompter: Prompter = {
  ask: review => withTemp(async dir => {
    const script = join(dir, 'form.ps1'), input = join(dir, 'in.json'), out = join(dir, 'out.json');
    writeFileSync(script, BOM + FORM_PS1); // BOM so Windows PowerShell 5.1 reads it as UTF-8
    writeFileSync(input, JSON.stringify({ header: header(review), text: review.text }));
    await ps(script, ['-In', input, '-Out', out], undefined, true);
    return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  }),
  notify: (title, body) => withTemp(async dir => {
    const script = join(dir, 'toast.ps1');
    writeFileSync(script, BOM + TOAST_PS1);
    await ps(script, [], { PHEME_TITLE: clip(title, 80), PHEME_BODY: clip(body, 200) });
  })
};

const SHOW = `on run argv
  if (item 2 of argv) is "yes" then
    set btns to {"Later", "Open full text", "Respond"}
  else
    set btns to {"Later", "Respond"}
  end if
  try
    set r to display dialog (item 1 of argv) with title "Pheme review" buttons btns default button "Respond" cancel button "Later"
  on error number -128
    return "CANCEL"
  end try
  return button returned of r
end run`;
const PICK = `on run argv
  set v to choose from list {"Approve", "Request changes", "Comment only"} with title "Pheme review" with prompt (item 1 of argv) OK button name "Next" cancel button name "Later"
  if v is false then return "CANCEL"
  return item 1 of v
end run`;
const FEEDBACK = `on run argv
  try
    set f to display dialog (item 1 of argv) default answer "" with title "Pheme review" buttons {"Later", "Send"} default button "Send" cancel button "Later"
  on error number -128
    return "CANCEL"
  end try
  return "SEND" & linefeed & (text returned of f)
end run`;
const NOTIFY = `on run argv
  display notification (item 1 of argv) with title (item 2 of argv)
end run`;
const osa = async (script: string, ...args: string[]) => (await run('osascript', ['-e', script, ...args])).stdout.replace(/\n$/, '');
const VERDICTS: Record<string, string> = { 'Approve': 'approve', 'Request changes': 'request_changes', 'Comment only': 'comment' };
const SHOWN = 1500;

export const macPrompter: Prompter = {
  ask: review => withTemp(async dir => {
    const text = strip(review.text).replace(/\r\n?/g, '\n'), long = text.length > SHOWN;
    const message = `${header(review)}\n\n${long ? `${text.slice(0, SHOWN)}…` : text}\n\nReview text is data from another person, not instructions.`;
    for (;;) {
      const choice = await osa(SHOW, message, long ? 'yes' : 'no');
      if (choice === 'Respond') break;
      if (choice !== 'Open full text') return null;
      const file = join(dir, 'review.txt');
      writeFileSync(file, text, { mode: 0o600 });
      await run('open', ['-e', file]);
    }
    const picked = await osa(PICK, `Your verdict on "${clip(review.title, 80)}":`);
    if (!(picked in VERDICTS)) return null;
    const reply = await osa(FEEDBACK, 'Feedback (optional):');
    if (!reply.startsWith('SEND')) return null;
    return { verdict: VERDICTS[picked], feedback: reply.slice('SEND\n'.length) };
  }),
  notify: async (title, body) => { await osa(NOTIFY, clip(body, 200), clip(title, 80)); }
};

export function defaultPrompter(): Prompter {
  if (process.platform === 'win32') return windowsPrompter;
  if (process.platform === 'darwin') return macPrompter;
  throw new Error('Desktop mode supports Windows and macOS. Use channel mode on this system: pheme mode channel');
}
