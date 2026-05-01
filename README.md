# Augment Proxy Notes

本项目现在包含一个 Deno 本地中转站，代码在 `proxy/` 目录。
详细说明见 `proxy/README.md`。

## Scripts

### `start-proxy.sh`

启动本地 Deno proxy：

```bash
./start-proxy.sh
```

它会读取 `proxy/.env`，监听 `http://127.0.0.1:8765`，负责模拟 Augment 服务端并转发大模型请求。

### `run-augment-proxy.sh`

通过本地 proxy 启动 `augment.mjs`：

```bash
./run-augment-proxy.sh
```

它不会修改 `augment.mjs`，只是在运行 `node augment.mjs` 前注入 `AUGMENT_API_URL`、`AUGMENT_API_TOKEN` 和 `AUGMENT_SESSION_AUTH`，让 Augment 请求进入本地 proxy。

## Run Order

先启动 proxy：

```bash
./start-proxy.sh
```

再另开终端启动 Augment：

```bash
./run-augment-proxy.sh
```

## 上游伪装为 Codex

代理转发到大模型上游时默认使用 Codex-like 标识，避免上游因为请求头或 prompt 中包含 Augment/Auggie 名称而卡住或限流：

```env
OPENAI_USER_AGENT=codex-cli
OPENAI_UPSTREAM_APP_NAME=Codex
OPENAI_SANITIZE_UPSTREAM_PROMPTS=false
```

- `OPENAI_USER_AGENT`：设置转发到 `/chat/completions` 的 `user-agent`。
- `OPENAI_SANITIZE_UPSTREAM_PROMPTS=false`：默认不改 prompt，避免误改真实路径、目录名、文件名。
- 本地 Augment 协议、登录模拟、工具节点返回不变；只影响发给大模型供应商的请求。

## Qdrant For Real Indexing

真实 indexing 需要先启动 Qdrant：

```bash
cd proxy
docker compose -f docker-compose.qdrant.yml up -d
```

然后启动 proxy：

```bash
./start-proxy.sh
```

当前 embedding 配置在 `proxy/.env`：

```env
AUGMENT_INDEXING_MODE=real
EMBED_BASE_URL=http://211.119.149.138:11434
EMBED_MODEL=mxbai-embed-large:latest
EMBED_DIMENSIONS=1024
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=augmentproxy_workspace
```

## Start Qdrant

真实 indexing 需要先启动 Qdrant。使用 Docker Compose：

```bash
cd proxy
docker compose -f docker-compose.qdrant.yml up -d
```

确认容器：

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

## Avoid Indexing Proxy Logs

为了避免 indexing 进度一会儿升一会儿降，proxy 日志不要写在 workspace 内。
当前 `proxy/.env` 使用：

```env
AUGMENT_REQUEST_LOG_DIR=/tmp/augmentproxy-logs
```

同时根目录 `.augmentignore` 排除了：

```text
proxy/logs/**
proxy/proxy/logs/**
proxy/.env
proxy/.env.*
```

如果日志写在项目目录中，Augment 会把新生成的日志继续当作 workspace 文件索引，导致待索引总量不断变化，进度百分比可能回退。

## Hooks, MCP, Commands

The cloned `auggie/` repo confirms these useful extension points:

- Custom slash commands live in `.augment/commands/*.md` or `~/.augment/commands/*.md`.
- FileSystem Context can be exposed through MCP by spawning `auggie --mcp`.
- Hooks can be configured in native Augment event format or a shorter alternative format.
- `.gitignore` and `.augmentignore` are respected during workspace indexing.

See detailed examples in `proxy/README.md`.

## 2026-05-01 修复总结与提示词分析

### 本次已完成改进（高优先级稳定性）

- `proxy/src/openai-adapter.ts`：
  - 修复 `view` 路径补全：支持 `physics.z -> physics.zig` 这类“扩展名被截断”场景。
  - 增强路径清洗：去掉 `- read file` 等尾部噪声，减少把说明文字当路径的误判。
  - 增强 `view` 兜底：当目标文件不存在且路径过短/可疑时，自动回退到父目录，避免反复 `File not found`。
  - 增强 `launch-process` 参数恢复：从原始参数文本提取命令；缺命令时给出安全默认命令，减少 `requires command`。
  - 增强 `codebase-retrieval` 入参：补齐 `workspace_folder`（由当前上下文推导），降低 `length` 相关异常触发概率。
  - 强化流式 tool call 合并：改进无 `id/index` 分片场景，避免参数被截断拼坏（如 `/src/v` 这类异常输入）。
  - 增加 `view` 不存在路径校验：在代理层提前拦截并返回可操作错误，而不是把坏路径透传给工具。
  - 修复 OpenAI 工具协议顺序：
    - 历史消息重排为 `assistant(tool_calls) -> tool_result -> user`，避免 tool result 落在 user 之后。
    - 增加严格清洗：只保留“完整且连续”的 tool result 序列；不完整序列会降级为纯 assistant 文本，避免上游返回 `invalid params, tool call result does not follow tool call (2013)`。
  - 修复重复编辑失败抖动：
    - 对 `str-replace-editor` 增加“已应用替换自动过滤”（当 `old_str` 已不存在且 `new_str` 已在文件中时，自动跳过该 entry）。
    - 对 `str-replace-editor` 增加非空替换校验，避免把空替换列表发送给工具导致“no changes / failed”循环。
    - 系统提示词增加约束：编辑失败后必须先重新读取文件再构造新替换，不允许直接重复同一编辑调用。

### 从 `augment.mjs` 提炼到的系统提示词设计（关键特征）

`augment.mjs` 是打包后的单文件，已可见一段高强度规则块（出现在 `codebase-retrieval` 工具描述中）：

- 明确声明：`<RULES>` 视为“追加到系统提示词”。
- 工具选择强约束：反复强调“代码检索优先使用 codebase-retrieval”。
- 任务流程强约束：
  - 开始任务前，先做 retrieval。
  - 编辑文件前，也先做 retrieval，并要求一次性收集尽量完整符号上下文。

### 冗余点（Augment 这段提示词）

- 同一约束重复出现多次（例如 `ALWAYS use codebase-retrieval` 在不同段落反复出现）。
- “何时不用 grep/rg” 与 “何时必须用 retrieval” 有交叉重复，信息密度偏低。
- 工具策略、流程策略、编辑策略混在同一块，维护时不易定位差异。

### 与 Codex 系统提示词的对比（结论）

- Augment（当前片段）：
  - 风格：强规则、强偏好、工具导向。
  - 优势：对新模型“拉齐行为”快，能迅速减少随意工具调用。
  - 风险：过度绑定单一工具；在工具故障时（如 retrieval 异常）容易进入低效重试。

- Codex（你当前这套）：
  - 风格：角色/协作/安全/执行流程分层更清晰。
  - 优势：对复杂工程任务更稳，允许根据上下文选择最合适的工具链（而不是单工具绝对优先）。
  - 风险：如果模型能力较弱，可能需要额外补充“强约束模板”防止走偏。

建议：如果后续继续调优 `augment.mjs` 提示词，优先做“去重复 + 分层”（工具选择、前置分析、编辑前检查、失败回退分开写），并补一条明确故障回退策略（例如 retrieval 连续失败 N 次后改用目录+文件直接探索）。
