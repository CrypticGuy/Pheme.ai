# Pheme

Named after Pheme, the Greek goddess and personification of rumor and report.

Pheme is a local broker and per-session Claude Code MCP stdio bridge for human review between two machines. Claude starts each bridge; the bridge makes outbound HTTP requests to the broker. No inbound bridge port is needed.

Requires Node **22.13+** (built-in `node:sqlite`, currently experimental on Node 22), npm, and a Claude Code release/account with custom Channels research-preview access and native MCP form elicitation. Channels availability and client behavior must be checked against the official docs linked below. No hosted account integration, publishing, firewall changes, or permission relay is included.

## Install on both machines

Clone/copy this project, then run in its directory:

```sh
npm install
npm run build
npm test
npm run typecheck
```

SQLite uses WAL and FULL synchronization; all changes, including events and idempotency records, commit in one transaction. State is stored as one JSON row for a small-team MVP. This is intentionally simple, with no native npm build dependency. Large inboxes require normalized tables, pagination, retention, and rate limiting before broader use. Keep the database on a local disk, outside a synchronized folder; set `PHEME_DB` to an absolute local path on the host. Do not delete WAL files while running. Back up using SQLite backup tooling or stop the broker and copy its files together.

## Machine A: broker host

Choose a reachable LAN address for this machine, for example `192.168.1.10`. Provision identities locally; there is no network enrollment/admin endpoint. Tokens are generated once and only their hashes are stored. Deliver Bob's token privately to Bob. Shell/terminal history and scrollback may retain the printed token.

PowerShell:

```powershell
$env:PHEME_DB = 'C:/PhemeData/pheme.sqlite'
npm run provision -- alice 'Alice'
npm run provision -- bob 'Bob'
./start-broker.ps1 -BindAddress 192.168.1.10
```

Bash:

```bash
export PHEME_DB="$HOME/.local/share/pheme/pheme.sqlite"
npm run provision -- alice Alice
npm run provision -- bob Bob
bash start-broker.sh 192.168.1.10
```

Leave the broker running in its terminal, or manage the same command with your existing service manager. Default bind is loopback; explicitly choosing the LAN address exposes it to that network. The project does not install a background service or change firewall rules. Check `http://192.168.1.10:8787/health` from both machines.

**HTTP sends tokens and review text in clear text.** Use only a trusted LAN for this MVP. For untrusted networks place the broker behind an HTTPS reverse proxy or authenticated encrypted tunnel, bind its upstream to loopback, and set clients to the HTTPS URL. The bridge supports HTTPS with normal certificate validation; never disable it. Do not expose this HTTP port to the public internet.

## Both machines: Claude setup

Copy `.mcp.example.json` to `.mcp.json` in the working project where you launch Claude. Set the command to your absolute Node executable (`Get-Command node` / `command -v node`) and args to your absolute `dist/bridge.js`. On Unix use e.g. `/usr/local/bin/node` and `/home/alice/pheme/dist/bridge.js`. Set Alice's token on A and Bob's on B; use the same host URL. Keep `.mcp.json` private and uncommitted. Whoever possesses a token can act as that person; this is a credential boundary, not hardware identity or cryptographic proof of human presence.

Launch Claude from that working project, approving the local MCP server if prompted:

```powershell
$env:MCP_PROTOCOL_NEGOTIATION = 'legacy'
claude --dangerously-load-development-channels server:pheme
```

```bash
MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:pheme
```

The supplied launch scripts set the same variable on the **Claude process**. The development flag explicitly loads this custom channel; ordinary MCP tools alone do not enable channel events. Custom Channels are local stdio only, so configure the local bridge rather than the remote broker as MCP. See [Claude Code Channels](https://code.claude.com/docs/en/channels) and [custom channel reference](https://code.claude.com/docs/en/channels-reference).

## Two-person walkthrough

1. In Alice's Claude terminal ask: “Use Pheme request_review to ask bob to review this proposal: …”. The tool returns the immutable review ID.
2. Bob's active terminal receives an event containing only fixed instructions and identifiers. Claude calls `present_review` with the ID. Pheme fetches the broker snapshot and opens a native form with `approve`, `request_changes`, or `comment`, plus optional feedback. **Bob chooses and accepts the form.** Review text is displayed as untrusted data.
3. Alice receives a response event. `finalize_review` displays the attributed snapshot and opens an owner form: `close` or `hand_to_agent`, with an optional note. Alice accepts. The tool returns the attributed final packet; handing to the agent does not execute anything automatically.
4. Canceling/dismissing either form records nothing. Ask Claude to use `list_pending`, then reopen the form. If the client lacks native form support, Pheme fails closed with no chat fallback.

There is deliberately no model-callable `approve`, `respond`, or raw finalization tool. Only accepted native form results reach those API calls from the bridge. The broker authenticates bearer identity and roles, not the origin of human intent: a person/process with the token can call the HTTP API directly. Do not grant untrusted code access to tokens or treat this as a security approval/permission system.

When a Claude session closes its child bridge stops, so it receives no live events. The broker retains unacknowledged events across restarts and replays on reconnect. ACK means notification written to the live MCP transport, not human acceptance; a crash after the write can cause duplicate delivery, and a crash after ACK can leave no replayed notification. `list_pending` always recovers unresolved reviews. Multiple sessions sharing one token compete for the same inbox, so use one active session per identity. Responses and finalizations require an expected version; stale forms return a conflict and must be reopened. Transport retries reuse idempotency keys; a manually repeated request tool call creates a new review.

## Local synthetic smoke and API

`npm test` launches a loopback broker, provisions synthetic users, creates a review, restarts the broker to verify queued replay, records a reviewer response, finalizes it, and verifies auth/role/version/idempotency failures. It exercises accepted, canceled, and malformed form inputs with a fake elicitation client, then spawns two real stdio bridge processes through MCP clients and verifies channel notifications, declared tools, form requests, and finalization. No real Claude session, accounts, or LAN changes are needed.

Authenticated endpoints use `Authorization: Bearer TOKEN`: `POST /reviews`, `GET /reviews` (unresolved only), `GET /reviews/:id`, `GET /inbox/events?wait_ms=25000`, `POST /events/:id/ack`, `POST /reviews/:id/response`, `POST /reviews/:id/finalize`. Mutating review routes require `Idempotency-Key` (8–128 alphanumeric/underscore/hyphen characters); response/finalization JSON includes `version`. Review text/title/participants cannot be edited after creation. `/health` is public. IDs double as inbox identifiers; the token selects its inbox, so callers cannot choose someone else's inbox in a query.

Remaining interactive smoke: run the two-machine walkthrough with supported Claude sessions and verify native forms, custom-channel delivery, cancel/reopen, offline queue, and terminal shutdown on the actual client version. Automated tests cannot establish that the Claude UI displayed a form to a person.
