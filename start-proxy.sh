#!/usr/bin/env bash
set -euo pipefail

echo "Stopping existing proxy processes..."
pkill -f "src/server.ts" || true
pkill -f "deno task start" || true

cd "$(dirname "${BASH_SOURCE[0]}")/proxy"
exec deno task start
