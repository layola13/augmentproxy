#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_URL="${AUGMENT_PROXY_URL:-http://127.0.0.1:8765}"

export AUGMENT_API_URL="$PROXY_URL"
export AUGMENT_API_TOKEN="${AUGMENT_API_TOKEN:-fake-augment-access-token}"
export AUGMENT_SESSION_AUTH="${AUGMENT_SESSION_AUTH:-$(cat <<JSON
{"accessToken":"${AUGMENT_API_TOKEN}","tenantURL":"${PROXY_URL}","scopes":["email","profile","offline_access"]}
JSON
)}"

exec  auggie "$@"
