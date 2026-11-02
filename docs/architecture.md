# Pheme architecture

This is the technical background for contributors and anyone running their own server. To use Pheme, start with [onboarding.md](../onboarding.md). To host it, see [operator-runbook.md](operator-runbook.md).

## Pieces

- **Bridge** (`bridge.ts`): a per-session Claude Code MCP stdio server and custom channel. Claude starts it; it never listens on a port. It makes outbound HTTP calls to the broker and turns inbox events into channel notifications.
- **Broker**: the only thing that listens. It exists in two forms with the same HTTP API, so the bridge does not care which one it talks to:
  - **Hosted**: a Supabase Edge Function (`supabase/functions/pheme`) over Postgres (`supabase/migrations`), with Supabase Auth for sign-up.
  - **LAN**: a Node broker (`broker.ts`, `store.ts`) over SQLite, for two machines on a trusted network.
- **CLI** (`cli.ts`, `claude-pheme.ts`): `pheme join`, `pheme connect` and friends, plus the `claude-pheme` launcher that starts Claude with the channel loaded.

Requires Node 22.13+ (built-in `node:sqlite`, still experimental on Node 22) and a Claude Code release with custom Channels (research preview) and native MCP form elicitation. See [Claude Code Channels](https://code.claude.com/docs/en/channels) and the [custom channel reference](https://code.claude.com/docs/en/channels-reference).

## Review flow

1. Alice asks Claude to get feedback from Bob. Claude calls `list_people`, picks Bob's handle, and calls `request_review`. The tool returns the immutable review ID.
2. Bob's active session receives an event containing only fixed instructions and identifiers. Claude calls `present_review` with the ID. Pheme fetches the broker snapshot and opens a native form with `approve`, `request_changes` or `comment`, plus optional feedback. **Bob chooses and accepts the form.** Review text is shown as untrusted data.
3. Alice receives a response event. `finalize_review` shows the attributed snapshot and opens an owner form: `close` or `hand_to_agent`, with an optional note. Alice accepts. The tool returns the attributed final packet; handing to the agent does not execute anything automatically.
4. Cancelling either form records nothing. `list_pending` reopens it. If the client lacks native form support, Pheme fails closed with no chat fallback.

There is deliberately no model-callable `approve`, `respond` or raw finalization tool. Only accepted native form results reach those API calls from the bridge.

## Trust model

- The broker authenticates bearer identity and roles, not the origin of human intent. A person or process holding a token can call the HTTP API directly. Pheme is a review channel, not a security approval or permission system. Do not give untrusted code access to tokens.
- Tokens are generated once and only their hashes are stored.
- Hosted: tables have RLS on with no policies, and all functions are executable only by `service_role`, so the anon key can read nothing. You can only send reviews to your connections.
- LAN: plain HTTP sends tokens and review text in clear text. Use it only on a trusted LAN, or put the broker behind HTTPS. Never expose the HTTP port to the internet, and never disable certificate validation.

## Delivery semantics

When a Claude session closes, its bridge stops and receives no live events. The broker keeps unacknowledged events across restarts and replays them on reconnect. ACK means the notification was written to the live MCP transport, not that a human accepted it. A crash after the write can cause duplicate delivery, and a crash after ACK can leave no replayed notification. `list_pending` always recovers unresolved reviews.

Several sessions sharing one token compete for the same inbox, so use one active session per identity. Responses and finalizations require an expected version; stale forms return a conflict and must be reopened. Transport retries reuse idempotency keys; a manually repeated `request_review` call creates a new review.

## HTTP API

Authenticated endpoints use `Authorization: Bearer TOKEN`:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/reviews` | Create a review |
| `GET` | `/reviews` | Unresolved reviews only |
| `GET` | `/reviews/:id` | |
| `GET` | `/inbox/events?wait_ms=25000` | Long poll |
| `POST` | `/events/:id/ack` | |
| `POST` | `/reviews/:id/response` | Requires `version` |
| `POST` | `/reviews/:id/finalize` | Requires `version` |

Mutating review routes require an `Idempotency-Key` header (8 to 128 letters, digits, `_` or `-`). Review text, title and participants cannot be edited after creation. `/health` is public. The token selects its inbox, so callers cannot read someone else's inbox.

## LAN broker storage

SQLite uses WAL and FULL synchronization; all changes, including events and idempotency records, commit in one transaction. State is stored as one JSON row, which is fine for a small team and needs no native npm build. Larger inboxes would need normalized tables, pagination, retention and rate limiting. Keep the database on a local disk outside any synced folder (`PHEME_DB`), do not delete WAL files while running, and back up with SQLite backup tooling or by stopping the broker and copying its files together.

## Tests

`npm test` launches a loopback broker, provisions synthetic users, creates a review, restarts the broker to check queued replay, records a response, finalizes it, and checks auth, role, version and idempotency failures. It exercises accepted, cancelled and malformed form input with a fake elicitation client, then spawns two real stdio bridges through MCP clients and checks channel notifications, tools, form requests and finalization. It needs no Claude session, accounts or network changes.

The Supabase smoke and end-to-end tests are described in [operator-runbook.md](operator-runbook.md#tests).

Automated tests cannot prove that the Claude UI showed a form to a person. Before a release, run the two-person walkthrough with real Claude sessions and check native forms, channel delivery, cancel and reopen, the offline queue, and shutdown.
