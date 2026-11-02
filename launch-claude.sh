#!/usr/bin/env bash
set -euo pipefail
export MCP_PROTOCOL_NEGOTIATION=legacy
exec claude --dangerously-load-development-channels server:pheme "$@"
