#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_BIN="${AGENT_BIN:-$(which agent)}"
API_URL="${CURSOR_PROXY_URL:-http://127.0.0.1:${CURSOR_PROXY_PORT:-8777}}"
AGENT_URL="${CURSOR_AGENT_URL:-$API_URL}"
export CURSOR_CONFIG_DIR="${CURSORPROXY_CONFIG_DIR:-$ROOT_DIR/state/config}"
export CURSOR_DATA_DIR="${CURSORPROXY_DATA_DIR:-$ROOT_DIR/state/data}"
mkdir -p "$CURSOR_CONFIG_DIR" "$CURSOR_DATA_DIR"

node - "$CURSOR_CONFIG_DIR/cli-config.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const file = process.argv[2];
let config = {};
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  config = {};
}

config.version ??= 1;
config.network = {
  ...(config.network && typeof config.network === "object" ? config.network : {}),
  useHttp1ForAgent: true,
};

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE

exec "$AGENT_BIN" \
  -e "$API_URL" \
  --agent-endpoint "$AGENT_URL" \
  --api-key "${CURSOR_API_KEY:-fake-cursorproxy-api-key}" \
  "$@"
