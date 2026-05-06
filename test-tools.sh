#!/bin/bash
echo "Testing list-remote-tools..."
curl -s -X POST http://127.0.0.1:8765/agents/list-remote-tools \
  -H "Content-Type: application/json" \
  -d '{"tool_id_list": {"tool_ids": [0,1]}}' | jq .

echo -e "\nTesting run-remote-tool..."
curl -s -X POST http://127.0.0.1:8765/agents/run-remote-tool \
  -H "Content-Type: application/json" \
  -d '{"tool_name": "exec_command", "arguments": {}}' | jq .
