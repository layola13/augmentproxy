# Augment Intercept Proxy

本目录是一个 Deno 本地中转站：让 Augment 客户端把原始 Augment API 请求打到本地 proxy，再由 proxy 转成 OpenAI 兼容大模型请求。

## Start

```bash
cd proxy
deno task start
```

开发模式：

```bash
cd proxy
deno task dev
```

## Configuration

配置写在 `proxy/.env`，当前已包含测试配置：

```env
PROXY_PORT=8765
OPENAI_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
OPENAI_API_KEY=...
OPENAI_MODEL=mimo-v2.5-pro
AUGMENT_REQUEST_LOG_DIR=proxy/logs
```

环境变量会覆盖 `.env` 中的同名值。

## Point Augment To Proxy

推荐用环境变量启动 Augment：

```bash
export AUGMENT_API_URL=http://127.0.0.1:8765
export AUGMENT_API_TOKEN=dummy
augment
```

如果客户端必须读取 session 文件，可以写入伪 session：

```json
{
  "accessToken": "fake-augment-access-token",
  "tenantURL": "http://127.0.0.1:8765",
  "scopes": ["email", "profile", "offline_access"]
}
```

通常路径是 `~/.augment/session.json`。

## Implemented Behavior

转发到 OpenAI 兼容上游：

- `POST /chat-stream`
- `POST /chat`
- `POST /prompt-enhancer`
- `POST /chat-input-completion`
- `POST /completion`
- `POST /completion/request`
- `POST /completion/complete`
- `POST /remote-agents/chat`

模拟登录/配置：

- `POST /token`
- `POST /get-models`
- `POST /get-credit-info`
- `POST /get-billing-summary`

暂时 mock 并记录请求：

- `context-canvas/*`
- `agent-workspace/*`
- `cloud-agents/*`
- `remote-agents/*`
- `settings/*`
- `tenant-secrets/*`
- `user-secrets/*`
- unknown endpoints

## Context Logs

context/workspace/unknown 请求会写到：

```text
proxy/logs/YYYY-MM-DD/*.json
```

日志会脱敏这些字段：`authorization`、`accessToken`、`apiKey`、`token`、`secret`、`password`。
后续可以根据这些样本补真实 context 模拟。

## Check

```bash
cd proxy
deno task check
```

## Helper Scripts

仓库根目录新增了两个脚本，用来减少手动导出环境变量的步骤。

### `start-proxy.sh`

用途：启动 Deno 中转站。

```bash
./start-proxy.sh
```

等价于：

```bash
cd proxy
deno task start
```

启动后会监听：

```text
http://127.0.0.1:8765
```

它负责接收 Augment 原始请求，模拟登录/config/context，并把 chat/completion 请求转发到 `.env` 中配置的大模型上游。

### `run-augment-proxy.sh`

用途：用本地 proxy 配置启动 `augment.mjs`。

```bash
./run-augment-proxy.sh
```

这个脚本不会修改 `augment.mjs` 文件本身，只是在启动 `node augment.mjs` 前临时注入这些环境变量：

```bash
AUGMENT_API_URL=http://127.0.0.1:8765
AUGMENT_API_TOKEN=fake-augment-access-token
AUGMENT_SESSION_AUTH={...}
```

其中 `AUGMENT_SESSION_AUTH` 是一个伪 Augment session，内容类似：

```json
{
  "accessToken": "fake-augment-access-token",
  "tenantURL": "http://127.0.0.1:8765",
  "scopes": ["email", "profile", "offline_access"]
}
```

这样 Augment 客户端会认为自己已经登录，并把 API 请求发到本地 proxy。

### Recommended Run Order

先启动 proxy：

```bash
./start-proxy.sh
```

再打开另一个终端启动 Augment：

```bash
./run-augment-proxy.sh
```

如果要修改本地 proxy 地址，可以覆盖默认变量：

```bash
AUGMENT_PROXY_URL=http://127.0.0.1:9000 ./run-augment-proxy.sh
```

## Indexing Capture Mode

proxy 默认开启 indexing capture 模式：

```env
AUGMENT_INDEXING_MODE=capture
```

在这个模式下：

- Augment 会先请求 `POST /find-missing`，body 里只有 `mem_object_names`，这些是本地文件内容计算出的 blob/memory 名称。
- proxy 会把这些名称全部返回到 `unknown_memory_names`，表示“服务端还没有这些内容”。
- Augment 随后应该请求 `POST /batch-upload`，body 里会带真实原料：`blob_name`、`path`、`content`。
- proxy 会完整记录 `batch-upload` 请求到 `logs/YYYY-MM-DD/*.json`，后续可以基于这些样本接入 embedding 模型和向量数据库。

如果只想让 indexing 快速通过，不采集文件原料，可以改成：

```env
AUGMENT_INDEXING_MODE=complete
```

此时 `/find-missing` 返回：

```json
{
  "unknown_memory_names": [],
  "nonindexed_blob_names": []
}
```

Augment 会认为远端已经有这些 blob，一般不会触发 `batch-upload`。

### Indexing 原料推断

当前已确认的链路：

1. `find-missing`
   - 请求：`{ "model": "...", "mem_object_names": ["hash1", "hash2"] }`
   - 响应必须是：`{ "unknown_memory_names": [], "nonindexed_blob_names": [] }`
2. `batch-upload`
   - 请求预计包含：`{ "blobs": [{ "blob_name": "...", "path": "...", "content": "..." }] }`
   - 响应必须是：`{ "blob_names": ["..."] }`
3. `checkpoint-blobs`
   - 请求包含 checkpoint 变更：`checkpoint_id`、`added_blobs`、`deleted_blobs`
   - 响应必须是：`{ "new_checkpoint_id": "..." }`

后续接 embedding/向量数据库时，应优先消费 `batch-upload.blobs[]`：

- `blob_name`：稳定内容 ID，可作为向量库 document/chunk id 前缀。
- `path`：源文件路径，可作为 metadata。
- `content`：文件文本内容，用于切块、embedding、入库。

## Real Indexing With Ollama Embeddings + Qdrant

当前已支持真实 indexing 入库模式：

```env
AUGMENT_INDEXING_MODE=real
EMBED_BASE_URL=http://211.119.149.138:11434
EMBED_MODEL=mxbai-embed-large:latest
EMBED_DIMENSIONS=1024
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=augmentproxy_workspace
INDEX_CHUNK_CHARS=1800
INDEX_CHUNK_OVERLAP=200
```

`EMBED_BASE_URL` 使用 Ollama 地址即可，proxy 会自动补成 OpenAI-compatible `/v1/embeddings`。

### Start Qdrant

```bash
cd proxy
docker compose -f docker-compose.qdrant.yml up -d
```

Qdrant 监听：

```text
http://127.0.0.1:6333
```

### Real Indexing Flow

1. `/find-missing`
   - 查询内存状态和 Qdrant payload，判断哪些 `blob_name` 已索引。
   - 未索引的返回到 `unknown_memory_names`。
2. `/batch-upload`
   - 接收 Augment 上传的 `blobs[]`。
   - 每个 blob 按 `INDEX_CHUNK_CHARS` 切块。
   - 调用 Ollama OpenAI-compatible embeddings。
   - 写入 Qdrant collection。
   - 返回成功入库的 `blob_names`。
3. `/checkpoint-blobs`
   - 记录 checkpoint。
   - 删除 `deleted_blobs` 对应的 Qdrant points。
   - 返回 `new_checkpoint_id`。

### Verify Qdrant

```bash
curl http://127.0.0.1:6333/collections/augmentproxy_workspace
```

查看已入库 chunks：

```bash
curl -s -X POST http://127.0.0.1:6333/collections/augmentproxy_workspace/points/scroll \
  -H 'content-type: application/json' \
  -d '{"limit":5,"with_payload":true,"with_vector":false}'
```

## Qdrant Docker Compose Commands

启动 Qdrant：

```bash
cd proxy
docker compose -f docker-compose.qdrant.yml up -d
```

查看容器是否运行：

```bash
docker ps | grep augmentproxy-qdrant
```

Qdrant HTTP 地址：

```text
http://127.0.0.1:6333
```

停止 Qdrant：

```bash
cd proxy
docker compose -f docker-compose.qdrant.yml down
```

查看 collections：

```bash
curl http://127.0.0.1:6333/collections
```

## Avoid Indexing Proxy Logs

不要把 proxy 请求日志写在当前 workspace 内，否则 Augment indexing 会把日志文件也纳入索引，日志越写越多，进度百分比可能回退。

当前推荐配置：

```env
AUGMENT_REQUEST_LOG_DIR=/tmp/augmentproxy-logs
```

根目录 `.augmentignore` 已排除：

```text
proxy/logs/**
proxy/proxy/logs/**
proxy/.env
proxy/.env.*
```

## Stream Heartbeat

`chat-stream` 会每 10 秒发送一个心跳 JSON line：

```json
{"heartbeat": true, "request_id": "..."}
```

这是为了避免工具调用、长上下文、慢模型响应时客户端认为流断开。正式实现 Augment 原生工具节点后，可以根据真实协议把 heartbeat 改成原生 keepalive chunk。

## Tool Calling Support

proxy now maps Augment tool definitions to OpenAI-compatible tools:

- Augment request `tool_definitions[]` -> OpenAI `tools[]`
- `input_schema_json` -> OpenAI function `parameters`
- OpenAI response `tool_calls[]` -> Augment response node:

```json
{
  "id": 1,
  "type": 5,
  "tool_use": {
    "tool_name": "view",
    "tool_use_id": "call_xxx",
    "input_json": "{...}"
  }
}
```

The proxy also converts prior Augment history back to OpenAI messages:

- `response_nodes[type=5].tool_use` -> assistant `tool_calls[]`
- `request_nodes[type=1].tool_result_node` -> OpenAI `tool` messages

This should allow Augment's local tool executor to see native tool-use nodes instead of plain `<tool_call>` text. If a model streams partial tool-call arguments, the proxy buffers streamed tool-call chunks and emits tool nodes near stream completion.

## Indexed Blob Persistence

The proxy stores indexed blob markers in Qdrant using payload `kind=blob_marker` and `blob_name`.
After proxy restart, `/find-missing` checks Qdrant before returning `unknown_memory_names`, so already indexed blobs should not be re-uploaded.

Qdrant payload kinds:

- `kind=blob_marker`: one marker point per indexed blob.
- `kind=chunk`: searchable text chunks for that blob.

If you want to force a full re-index, delete the Qdrant collection:

```bash
curl -X DELETE http://127.0.0.1:6333/collections/augmentproxy_workspace
```

## Reasoning / Thinking Tags

Some upstream models emit reasoning as XML-like tags. The proxy extracts these tags from model output:

- `<think>...</think>`
- `<thinking>...</thinking>`
- `<reason>...</reason>`

Extracted content is emitted as Augment thinking nodes:

```json
{
  "type": 8,
  "thinking": { "content": "..." }
}
```

The visible assistant text has those tags removed.

## `find-missing` Performance

`/find-missing` uses Qdrant marker point IDs for fast lookup after restart. It also falls back to a payload scroll for older chunks that were indexed before blob markers existed.

If indexing appears stuck at a low percentage and logs show:

```text
find-missing call failed with APIStatus unavailable
The operation was aborted due to timeout
```

restart proxy after pulling the latest code so the optimized lookup is active.

## Hooks, MCP, And Commands

This section summarizes the extension points found from `augment.mjs` and the official `auggie/` examples cloned in this workspace.

### Custom Slash Commands

Auggie supports reusable slash commands as Markdown files.

Project-local commands:

```text
.augment/commands/code-review.md
.augment/commands/tests.md
```

User-global commands:

```text
~/.augment/commands/code-review.md
```

Example command file:

```markdown
---
description: Review a file for correctness and maintainability
---

Review the target file or directory: $ARGUMENTS

Focus on:
- bugs
- security
- maintainability
- tests
```

Usage:

```bash
auggie "/code-review proxy/src"
```

The official examples are in:

```text
auggie/examples/commands/
```

### `.augmentignore`

Auggie indexing respects `.gitignore` and `.augmentignore`.

For this proxy project, keep generated logs and secrets out of indexing:

```text
proxy/logs/**
proxy/proxy/logs/**
proxy/.env
proxy/.env.*
.git/**
node_modules/**
```

This prevents proxy request logs from becoming new files that Auggie then tries to index again.

### MCP: FileSystem Context

The official TypeScript SDK example uses MCP by spawning Auggie:

```ts
const context = await FileSystemContext.create({
  directory: workspaceDir,
  auggiePath: "auggie",
  debug: true,
});
```

Equivalent conceptually:

```bash
auggie --mcp
```

Authentication is read from either:

```bash
AUGMENT_API_TOKEN
AUGMENT_API_URL
```

or:

```text
~/.augment/session.json
```

For this proxy, use the wrapper so MCP traffic points to local proxy:

```bash
AUGMENT_PROXY_URL=http://127.0.0.1:8765 ./run-augment-proxy.sh --mcp
```

If an external MCP client needs a command entry, use:

```json
{
  "mcpServers": {
    "augment-filesystem": {
      "command": "bash",
      "args": ["/home/vscode/projects/augmentproxy/run-augment-proxy.sh", "--mcp"]
    }
  }
}
```

### MCP Through Augment Settings

The proxy currently mocks these endpoints and records requests:

```text
/settings/get-mcp-tenant-settings
/settings/get-mcp-user-settings
/settings/get-mcp-tenant-configs
/settings/get-mcp-user-configs
/settings/upsert-mcp-tenant-config
/settings/upsert-mcp-user-config
/settings/remove-mcp-tenant-config
/settings/remove-mcp-user-config
```

Current mock behavior returns empty MCP configs. To make server configs persistent, implement these endpoints in `proxy/src/fake-augment.ts` with a local JSON store such as:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "type": "stdio",
      "command": "bash",
      "args": ["/home/vscode/projects/augmentproxy/run-augment-proxy.sh", "--mcp"]
    }
  ]
}
```

### Hooks: Native Format

`augment.mjs` recognizes native hook events:

```text
PreToolUse
PostToolUse
Stop
SessionStart
SessionEnd
Notification
```

Native config shape:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo",
            "args": ["before shell execution"],
            "timeout": 5000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "echo",
            "args": ["after file edit"],
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

Matchers are regex strings. Common matcher examples:

```text
Bash
Read
Edit|Write
MCP:.*
```

### Hooks: Alternative Short Format

`augment.mjs` also maps this shorter format into native events:

```json
{
  "hooks": {
    "beforeShellExecution": [
      { "command": "echo", "args": ["before bash"], "timeout": 5000 }
    ],
    "afterShellExecution": [
      { "command": "echo", "args": ["after bash"], "timeout": 5000 }
    ],
    "beforeMCPExecution": [
      { "command": "echo", "args": ["before mcp"], "timeout": 5000 }
    ],
    "afterMCPExecution": [
      { "command": "echo", "args": ["after mcp"], "timeout": 5000 }
    ],
    "beforeReadFile": [
      { "command": "echo", "args": ["before read"], "timeout": 5000 }
    ],
    "afterFileEdit": [
      { "command": "echo", "args": ["after edit"], "timeout": 5000 }
    ],
    "stop": [
      { "command": "echo", "args": ["agent stopped"], "timeout": 5000 }
    ]
  }
}
```

Alternative mappings inferred from `augment.mjs`:

```text
beforeShellExecution -> PreToolUse matcher Bash
beforeMCPExecution   -> PreToolUse matcher MCP:.*
beforeReadFile       -> PreToolUse matcher Read
afterFileEdit        -> PostToolUse matcher Edit|Write
afterShellExecution  -> PostToolUse matcher Bash
afterMCPExecution    -> PostToolUse matcher MCP:.*
stop                 -> Stop
```

### Hook Storage Notes

The exact file path can vary by Auggie version/config source. Practical places to try:

```text
.augment/hooks.json
.augment/config.json
~/.augment/hooks.json
~/.augment/config.json
```

After adding hooks, restart Auggie. If hooks do not fire, check `/tmp/augmentproxy-logs` for settings/config requests, then persist the relevant settings endpoint in the proxy.

### Proxy Support Status

Currently implemented:

- Records MCP settings requests.
- Returns empty MCP config mocks.
- Supports native tool call nodes from OpenAI `tool_calls`.
- Supports tool result history conversion.

Not yet implemented:

- Persistent MCP settings store.
- Hook config injection from proxy settings endpoints.
- Remote MCP auth secret storage.
