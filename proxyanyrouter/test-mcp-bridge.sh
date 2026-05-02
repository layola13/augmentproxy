#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$(mktemp -d /tmp/proxyanyrouter-test.XXXXXX)"
MOCK_LOG="$LOG_DIR/mock.log"
CLIENT_STREAM="$LOG_DIR/client.sse"
MOCK_PID=""
PROXY_PID=""

cleanup() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT_DIR"

rm -f "$MOCK_LOG"
touch "$MOCK_LOG"

PROXYANYROUTER_MOCK_PORT=8877 \
PROXYANYROUTER_MOCK_LOG="$MOCK_LOG" \
deno task mock-upstream >"$LOG_DIR/mock.stdout" 2>&1 &
MOCK_PID=$!

PROXYANYROUTER_PORT=8876 \
PROXYANYROUTER_UPSTREAM_URL="http://127.0.0.1:8877/v1/responses" \
PROXYANYROUTER_MCP_CONFIG="$ROOT_DIR/mcp-tools.json" \
deno task start >"$LOG_DIR/proxy.stdout" 2>&1 &
PROXY_PID=$!

python3 - <<'PY'
import json
import time
import urllib.request

for _ in range(60):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8876/health", timeout=1) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            if payload.get("ok") is True:
                raise SystemExit(0)
    except Exception:
        time.sleep(0.2)
raise SystemExit("proxyanyrouter health check did not become ready")
PY

curl -sS -N \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -X POST http://127.0.0.1:8876/v1/responses \
  --data @- >"$CLIENT_STREAM" <<'JSON'
{
  "model": "gpt-5.3-codex",
  "instructions": "Use the MCP tool to read anyrouter.md, then answer with the wire_api value only.",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Read anyrouter.md with the MCP tool and report the wire_api value."
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "namespace",
      "name": "mcp__proxyanyrouter_local__",
      "description": "ProxyAnyRouter local MCP namespace",
      "tools": [
        {
          "type": "function",
          "name": "read_anyrouter_doc",
          "description": "Read the local anyrouter.md provider note",
          "parameters": {
            "type": "object",
            "properties": {},
            "required": []
          }
        }
      ]
    }
  ]
}
JSON

python3 - "$MOCK_LOG" "$CLIENT_STREAM" <<'PY'
import json
import sys
from pathlib import Path

mock_log = Path(sys.argv[1])
client_stream = Path(sys.argv[2])

requests = [
    json.loads(line)
    for line in mock_log.read_text(encoding="utf-8").splitlines()
    if line.strip()
]
assert len(requests) == 2, f"expected 2 upstream requests, got {len(requests)}"

first = requests[0]["body"]
second = requests[1]["body"]

tools = first.get("tools", [])
tool_names = [tool.get("name") for tool in tools if isinstance(tool, dict)]
assert "mcp__proxyanyrouter_local__read_anyrouter_doc" in tool_names, tool_names
assert all(tool.get("type") != "namespace" for tool in tools if isinstance(tool, dict)), tools

assert second.get("previous_response_id") == "resp-1", second
inputs = second.get("input", [])
assert inputs and inputs[0].get("type") == "function_call_output", inputs
assert inputs[0].get("call_id") == "call-1", inputs[0]
assert "wire_api = \"responses\"" in inputs[0].get("output", ""), inputs[0]

stream_text = client_stream.read_text(encoding="utf-8")
assert "event: response.output_text.delta" in stream_text, stream_text
assert "wire_api = responses" in stream_text, stream_text

print("proxyanyrouter MCP bridge test passed")
print(f"artifacts: {mock_log.parent}")
PY
