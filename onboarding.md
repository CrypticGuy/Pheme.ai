# Getting started with Pheme

Pheme lets your Claude Code ask another person for a review and bring their answer back. You say "get feedback on this plan from Bob", Bob's Claude is pinged, Bob chooses a verdict in a form on his own screen, and you see his answer. Only a person can approve or reject, never an agent.

This takes about five minutes. You only need a terminal.

## What you need

- **Node.js 22.13 or newer** (`node --version`). Get it from nodejs.org if you need to.
- **Git**.
- **Claude Code**, signed in, with access to custom Channels (a research preview). If `claude --version` works but the channel doesn't load later, ask whoever invited you whether your account has Channels access.
- An **email address you can open**. You'll confirm it once.

## 1. Install

```bash
git clone https://github.com/CrypticGuy/Pheme.ai.git
cd Pheme.ai
npm install
npm link
```

`npm install` also builds the project. `npm link` adds two commands to your terminal: `pheme` and `claude-pheme`. If `npm link` complains about permissions, run the terminal as administrator once (Windows) or fix your npm prefix; or skip it and use `npm run pheme -- <command>` in place of `pheme <command>` below.

## 2. Create your account (one command)

```bash
pheme join <server URL>
```

Use the server URL from your invite. It looks like `https://<project>.supabase.co/functions/v1/pheme`. Running your own server instead? See [docs/operator-runbook.md](docs/operator-runbook.md).

It asks for:
- your **email** and a **password** (at least 8 characters),
- a **handle** (your short name, letters, digits, `_` or `-`; this is what others will see),
- a **display name**.

Then:
1. **Check your inbox** for a confirmation email and click the link. The page it opens may not load (it points at `localhost`); that's fine, your email is confirmed anyway. The command is waiting and carries on by itself.
2. It claims your handle and saves your private token on your machine (`~/.pheme/config.json`). Never share that file.

If you see "Handle is taken", run it again with another handle. It is safe to rerun at any point.

## 3. Connect with the person you'll work with

You can only message people you're connected with. Connect by their email:

```bash
pheme connect <their email address>
pheme connections
```

- If they've already joined, you're connected straight away and they'll see you in their list too.
- If they haven't joined yet, `connections` shows them as waiting, and you're connected the moment they run step 2.
- Use the email address they signed up with.

## 4. Start Claude with Pheme

```bash
claude-pheme
```

Use it instead of `claude`, from any folder. The first run registers Pheme with your Claude Code; after that it starts Claude with the Pheme channel loaded. You can pass normal Claude options after it, for example `claude-pheme --resume`.

## 5. Try it

In Claude, ask:

> Get feedback on this plan from Bob: *(paste or describe the plan)*

What happens:
1. Claude looks up your connections, finds Bob by name, and asks you if it's unsure which person you mean.
2. Bob's Claude gets pinged. Bob opens the review and picks **approve**, **request changes** or **comment** in a form, with optional notes.
3. You're pinged with his answer. Claude shows it to you, and you choose to **close** the review or **hand it to the agent** (Claude then has Bob's attributed feedback to work with; it doesn't act on it automatically).

If you're the reviewer, Claude will tell you a review is waiting. Ask it to open the review, then answer in the form. If you close the form without choosing, nothing is recorded; ask Claude to "list my pending reviews" to open it again.

Review text from other people is shown to Claude as untrusted data. Don't approve something just because the text asks you to.

## See what's waiting on you

```bash
pheme pending
```

This lists the reviews waiting on your verdict, the answered ones waiting for you to close, and the ones you sent that nobody has answered yet. It only reads, so it's safe to run any time, even when Claude isn't open.

To get the same view inside Claude Code in every project, install the skill once:

```bash
pheme install-skill
```

Then type `/pheme-pending` in any Claude Code session, or ask "what reviews are waiting on me?". Run `pheme install-skill` again after you update or move Pheme.

## Everyday commands

| Command | What it does |
|---|---|
| `pheme connect <email>` | Connect with someone (now, or when they join) |
| `pheme connections` | Who you're connected with, and who is pending |
| `pheme pending` | Reviews waiting on you, and the ones you're waiting on (`--json` for scripts) |
| `pheme install-skill` | Add the `/pheme-pending` skill to Claude Code for all your projects |
| `pheme whoami` | Your login and handle |
| `pheme rotate` | New token (the old one stops working). Restart Claude afterwards |
| `pheme logout` | Forget the login on this machine |
| `pheme join <url>` | Run again on a new machine to set it up there |

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm: command not found` or Node too old | Install Node 22.13+ |
| No confirmation email | Look in spam. The service sends only a few emails per hour, so wait a bit and run `pheme join` again |
| "Invalid login credentials" after confirming | Wrong password, or an account with that email already exists. Use the original password |
| "Not registered on this machine" | Run `pheme join <url>` first |
| `claude-pheme` not found | Run `npm link` again in the Pheme folder, or use `npm run pheme -- ...` for CLI commands and start Claude with `MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:pheme` |
| Claude doesn't show Pheme tools | Start it with `claude-pheme`, not plain `claude`. Ask Claude to list its tools and look for `list_people` and `request_review` |
| "Recipient not found among your connections" | You aren't connected yet, or they used a different email. Check `pheme connections` |
| No ping when someone sends you a review | Make sure you started Claude with `claude-pheme`; ask Claude to "list my pending reviews" to catch up |
| Other problems | Send the exact error text to whoever invited you |

## Good to know

- Anyone who knows your email can connect with you and send you review requests. Approvals aren't built yet, so share the URL only with people you trust.
- Your token lets anyone act as you. Keep `~/.pheme/config.json` private; if it leaks, run `pheme rotate`.
- Everything travels over HTTPS to the shared Pheme server. Review titles and text are stored there.

For the technical background and hosting details, see [docs/operator-runbook.md](docs/operator-runbook.md).
