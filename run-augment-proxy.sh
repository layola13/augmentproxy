#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_URL="${AUGMENT_PROXY_URL:-http://127.0.0.1:8765}"
AUTO_CONTINUE_CONFIG="${AUGGIE_AUTO_CONTINUE_CONFIG:-$ROOT_DIR/tmp/.codex/hooks.json}"
AUTO_CONTINUE_ACTIVE="${AUGGIE_AUTO_CONTINUE_ACTIVE:-0}"

export AUGMENT_API_URL="$PROXY_URL"
export AUGMENT_API_TOKEN="${AUGMENT_API_TOKEN:-fake-augment-access-token}"
export AUGMENT_SESSION_AUTH="${AUGMENT_SESSION_AUTH:-$(cat <<JSON
{"accessToken":"${AUGMENT_API_TOKEN}","tenantURL":"${PROXY_URL}","scopes":["email","profile","offline_access"]}
JSON
)}"

has_arg() {
  local needle="$1"
  shift
  local arg
  for arg in "$@"; do
    [[ "$arg" == "$needle" ]] && return 0
  done
  return 1
}

json_value() {
  local key="$1"
  python3 - "$AUTO_CONTINUE_CONFIG" "$key" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    data = {}
config = data.get("auto_continue", {}) if isinstance(data, dict) else {}
value = config
for part in key.split("."):
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(part)
if isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, (str, int, float)):
    print(value)
PY
}

auto_continue_enabled() {
  [[ -f "$AUTO_CONTINUE_CONFIG" ]] || return 1
  [[ "$(json_value enabled)" != "false" ]] || return 1
  [[ "$AUTO_CONTINUE_ACTIVE" != "1" ]] || return 1
  has_arg "--print" "$@" || has_arg "-p" "$@" || return 1
  return 0
}

if ! auto_continue_enabled "$@"; then
  exec auggie "$@"
fi

tmp_output="$(mktemp -t augmentproxy-auggie-output.XXXXXX)"
cleanup() { rm -f "$tmp_output"; }
trap cleanup EXIT

set +e
auggie "$@" 2>&1 | tee "$tmp_output"
status=${PIPESTATUS[0]}
set -e

if rg -q "maximum iterations reached|You can continue the conversation" "$tmp_output"; then
  export AUGGIE_AUTO_CONTINUE_ACTIVE=1
  prompt="$(json_value continue_prompt)"
  if [[ -z "$prompt" ]]; then
    prompt="继续执行未完成任务，先给出当前进度，然后继续下一步。"
  fi
  log_file="$(json_value log_file)"
  if [[ -z "$log_file" ]]; then
    log_file="/tmp/augmentproxy-auto-continue.log"
  fi
  mkdir -p "$(dirname "$log_file")"
  printf '\n[%s] auto-continue triggered by max iterations\n' "$(date -Is)" >>"$log_file"
  auggie --print --quiet --continue "$prompt" 2>&1 | tee -a "$log_file"
  status=${PIPESTATUS[0]}
fi

exit "$status"
