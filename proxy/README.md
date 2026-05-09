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
SWITCH_API=OPENAI
OPENAI_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
OPENAI_API_KEY=...
OPENAI_MODEL=mimo-v2.5-pro
CODEX_BASE_URL=https://anyrouter.top/v1
CODEX_API_KEY=...
CODEX_MODEL=gpt-5.3-codex
OPENAI_USER_AGENT=codex-cli
OPENAI_UPSTREAM_APP_NAME=Codex
OPENAI_SANITIZE_UPSTREAM_PROMPTS=false
AUGMENT_REQUEST_LOG_DIR=proxy/logs
```

环境变量会覆盖 `.env` 中的同名值。

`SWITCH_API=OPENAI` sends upstream model requests to `OPENAI_BASE_URL/chat/completions` with `OPENAI_API_KEY` and `OPENAI_MODEL`.
`SWITCH_API=CODEX` sends upstream model requests to `CODEX_BASE_URL/responses` with `CODEX_API_KEY` and `CODEX_MODEL`.
The two API keys are intentionally separate and are not used as fallbacks for each other.

Expert sub-agent routing is configured in `proxy/config.toml`, not in `.env`:

```toml
model_provider = "difu"
expert_provider = "expert"

[model_providers.expert]
base_url = "https://api.openai.com/v1"
api_keys = ["sk-expert-***"]
model = "gpt-5.3-codex"
```

When an `askexpert` sub-agent session is detected, the proxy sends that request to `expert_provider` using OpenAI-compatible `/chat/completions`. Main agent traffic still uses `model_provider` or `SWITCH_API=CODEX`.

## Sub-Agent Templates

Repository templates live in `proxy/agents/`. Copy them to `~/.augment/agents/` and enable the matching names in `~/.augment/feature-config.json`.

- `code`: implements and edits files, but does not run commands.
- `validate`: runs commands, tests, builds, and reproductions, but does not save files.
- `judge`: read-only completion judge.
- `askexpert`: read-only expert diagnosis routed to `expert_provider`.
- `docs`: reads/searches/analyzes the system and writes Markdown docs or system wiki files only.

## Upstream Identity / Codex-like Requests

Some OpenAI-compatible providers behave differently when request headers or prompts contain app-specific names. The proxy therefore sends upstream model requests with a Codex-like identity by default:

```env
OPENAI_USER_AGENT=codex-cli
OPENAI_UPSTREAM_APP_NAME=Codex
OPENAI_SANITIZE_UPSTREAM_PROMPTS=false
```

- `OPENAI_USER_AGENT` sets the upstream `user-agent` header for `/chat/completions` requests.
- `OPENAI_SANITIZE_UPSTREAM_PROMPTS=false` keeps prompts unchanged by default, avoiding accidental rewrites of real paths, directory names, and filenames.
- Local Augment protocol responses are unchanged; only the request sent to the model provider is sanitized.
- Only set `OPENAI_SANITIZE_UPSTREAM_PROMPTS=true` for a provider that explicitly requires app-name sanitization.

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

## Chat Stream Replay

仓库内置了一个日志回放脚本，用于本地重放 `POST /chat-stream` 请求，并验证 proxy 的 tool-call 过滤与恢复逻辑。

脚本位置：

```text
proxy/scripts/replay-chat-stream.ts
```

该脚本最初来自 `/tmp/replay-current.ts`，已适配当前 `ProxyConfig` 结构和当前代码路径。

运行方式：

```bash
cd proxy
deno run --allow-env --allow-read scripts/replay-chat-stream.ts <log-json-path> [launch-command]
```

示例（可回放的完整 body 日志）：

```bash
cd proxy
deno run --allow-env --allow-read scripts/replay-chat-stream.ts /tmp/augmentproxy-logs/2026-05-06/2026-05-06T02-58-53-055Z-POST-chat-stream.json
```

注意事项：

- 如果日志文件里的 `body` 是 `"[BODY_TOO_LARGE: ...]"`，说明原始请求体已被截断，脚本会直接报错并提示该日志不可回放。
- 回放脚本会 mock 上游 SSE 输出（默认优先用 `launch-process`，若该工具在日志定义中不可用会自动改用 `view`），用于稳定复现 proxy 内部处理流程。

## Chat Stream Summary Replay

对于 `body` 已经被截断、但仍保留 `body_summary` 的大日志，仓库内置了一个摘要回放脚本：

```text
proxy/scripts/replay-chat-stream-summary.ts
```

运行方式：

```bash
cd proxy
deno run --allow-read scripts/replay-chat-stream-summary.ts <log-json-path>
```

示例（适用于 `BODY_TOO_LARGE` 日志）：

```bash
cd proxy
deno run --allow-read scripts/replay-chat-stream-summary.ts /tmp/augmentproxy-logs/2026-05-08/2026-05-08T11-19-02-191Z-POST-chat-stream.json
```

这个脚本不会尝试还原完整原始请求体，而是：

- 从 `body_summary.chat_history.recent` 合成一个最小可重放上下文
- 复用摘要里最后一轮 assistant 的 `response_text` / `text_nodes` / `tool_uses`
- 直接验证当前 proxy 是否会在 `tool_choice=required` 的场景下补出恢复工具节点

适合排查这类问题：

- 上游只输出 `Let me directly view the key files...` 之类的文字，没有真正 tool call
- `codebase-retrieval` 返回 `Found 0 files`
- 怀疑 `chat-stream` 收尾阶段没有自动恢复到 `view`

## Repeated Failure Loop Replay

仓库还内置了一个纯本地循环回放脚本，用于稳定复现并验证 repeated-failure 自动恢复链：

```text
proxy/scripts/replay-loop.ts
```

运行方式：

```bash
cd proxy
deno run --allow-env --allow-read --allow-write scripts/replay-loop.ts 120
```

当前预期行为：

- 第一次失败后依次进入 `view diagnostic -> grep -> view definition -> directive -> exhausted`。
- `directive` 只能出现一次。
- `exhausted` 只能出现一次。
- 后续轮次不应再自动注入新的 `view` / `grep` / `directive` 恢复工具。

## Agent Exposure Policy

当前 `openai/router` 链路已经改成“主线程优先，本地直做”：

- 默认主线程不会向模型暴露任何 `sub-agent-*` 工具。
- 只有两种情况会在主线程暴露 `sub-agent-*`：
  - 用户明确要求 `sub-agents` / `delegation` / `parallel agent work`
  - 用户明确提出并行 sidecar 任务
- 仅仅因为用户要求“评估 / 调研 / 深入分析 / 详细计划”，不会自动进入 agent 模式。
- 仅仅提到 “agent mode” 或笼统提到 “agent” 也不算授权。
- 子代理会话一律不再继续暴露 `sub-agent-*`，禁止嵌套派生 agent。
- `plan` / `explore` / `docs` / `judge` / `askexpert` 都按子代理会话处理，不再持有主线程的工具权限。
- 如果主线程已经有 `view` / `save-file` / `str-replace-editor` / `launch-process` 等直接工具，优先由主线程完成，不再自动偷偷改派到 `sub-agent-code` 或 `sub-agent-validate`。

这次调整的目的，是消除以下两类死循环：

- 主线程因为工具表里存在 `sub-agent-*` 而不断偏向 `plan/explore/export`
- 子代理或恢复链在不可用工具上自动改派到另一个 agent，形成嵌套切换和无效循环

当前已经专门验证两条关键链路：

- `main -> plan -> main`
  - 主线程只有在明确并行/委托请求时才会暴露 `sub-agent-plan`
  - `plan` 子代理自身不再暴露任何 `sub-agent-*`
  - `plan` 完成后回到主线程，主线程继续使用本地工具，当前恢复表现为 `view` 工作区而不是自动跳 `code`
- `main -> explore -> code`
  - 这条链路现在被明确阻断
  - 即使主线程因明确并行请求暴露了 `sub-agent-explore` 和 `sub-agent-code`，`explore` 子代理自身也不能再进入 `code`
  - `explore` 完成后回到主线程，主线程继续用本地工具恢复，不会自动进入 `code`

如果后续产品要支持 `main -> explore -> code` 自动交接，必须先在协议层重新定义：

- 哪些情况下主线程允许自动交接
- 是否允许子代理返回结构化“建议切换 code”
- 切换决策由主线程还是 proxy 执行

在这些规则明确之前，proxy 当前行为是保守且有意的：回主线程，本地直做，不自动切 `code`。

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

For Augment CLI / Auggie sessions, `AUGMENT_INDEXING_MODE=real` now means real
indexing:

- `POST /find-missing` checks Qdrant marker state and returns genuinely unknown
  blob names.
- `POST /batch-upload` chunks file content, calls the embedding model, and
  writes both `kind=chunk` and `kind=blob_marker` records into Qdrant.
- `POST /checkpoint-blobs` updates in-memory checkpoint state and deletes Qdrant
  points for removed blobs.

If codebase retrieval returns `Indexed blobs considered: 0`, first verify that
this indexing chain is actually succeeding for the active workspace.

## Agent Usage Stats

The proxy exposes subagent token totals at:

```text
GET /agents/usage-stats
```

Usage attribution works in two cases:

- Fake cloud agents that pass an explicit `agent_id`.
- Real Augment subagents whose `chat-stream` / `chat` body has a child
  `conversation_id` with `parent_conversation_id`, `root_conversation_id`, or
  `# Sub-Agent Prompt` in `user_guidelines`.

Streaming and non-streaming upstream usage fields are both counted. In real
subagent mode the key is the child `conversation_id`, because Augment does not
send `agent_id` on the actual model request.

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

## Runtime Error Notes

### Qdrant `connection closed before message completed`

This can happen when large vector upserts overload or reset the local Qdrant HTTP connection. The proxy now retries Qdrant requests and writes vector points in small batches of 16.

If it still happens:

```bash
cd proxy
docker compose -f docker-compose.qdrant.yml restart qdrant
```

### Upstream `http2 error: stream error received`

This is an upstream model provider transport error while streaming. The proxy catches the failed `fetch()` and returns an Augment-style upstream stream error instead of crashing.

### Heartbeat `stream controller cannot close or enqueue`

This happens when the client closes a stream while the heartbeat timer is still trying to write. The proxy now uses guarded enqueue/close helpers and clears heartbeat safely.

## Augment `UND_ERR_HEADERS_TIMEOUT`

If Auggie reports:

```text
API Error: unavailable: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

it means Auggie did not receive response headers from the proxy quickly enough. This can happen when the proxy waits for a slow upstream model before returning the stream response.

`chat-stream` now returns headers immediately and sends an initial heartbeat chunk before contacting the upstream model. Heartbeats continue every 5 seconds while waiting for upstream tokens.

## Native Augment Thinking Nodes

Augment supports thinking as response node `type=8`:

```json
{
  "id": 1000,
  "type": 8,
  "thinking": { "content": "reasoning text" }
}
```

The proxy maps upstream reasoning into this native node format from two sources:

- XML-like text tags: `<think>`, `<thinking>`, `<reason>`
- OpenAI-compatible reasoning fields: `reasoning_content`, `reasoning`, `thinking`, `reason`

For streamed responses, the proxy buffers upstream text, extracts reasoning, then emits visible text plus `type=8` thinking nodes. This avoids showing raw `<think>...</think>` tags as normal assistant text.

## Streaming Thinking Filter

For streamed responses, visible text is emitted immediately. The proxy only buffers text inside these tags:

```text
<think>...</think>
<thinking>...</thinking>
<reason>...</reason>
```

The buffered reasoning is emitted at the end as native Augment `type=8` thinking nodes. This prevents long reasoning from blocking visible output for minutes.
