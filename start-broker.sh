#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export PHEME_BIND="${1:-127.0.0.1}"
export PHEME_PORT="${2:-8787}"
exec node dist/broker.js
