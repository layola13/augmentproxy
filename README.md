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
- `SWITCH_API=OPENAI|CODEX`：选择上游协议；`OPENAI` 使用 `OPENAI_BASE_URL/chat/completions`，`CODEX` 使用 `CODEX_BASE_URL/responses`。
- `OPENAI_API_KEY/OPENAI_MODEL` 和 `CODEX_API_KEY/CODEX_MODEL` 分开配置，不互相 fallback。
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

## 2026-05-07 子代理角色与限权调查

这次排查有一个关键发现：之前看到的“agent 一调用就不会写文件 / 不会跑命令”，不能简单归因成“所有子代理工具都坏了”。更准确地说，是“被调用的子代理类型本来就被设计成只读”，同时代理侧或暴露链路可能没有把可写子代理完整提供给主会话。

### 已确认事实

- `augment.mjs` 内置了一个名为 `explore` 的子代理角色。它的提示词明确要求：
  - 只做代码库探索和信息收集
  - `Do NOT modify any files`
  - `Do NOT run any commands or launch any processes`
- 同一个 `augment.mjs` 里还定义了其他内置子代理角色：
  - `plan`：做计划，禁用 `str-replace-editor` 和 `launch-process`
  - `code`：做实现，允许写文件和编辑，但禁用 `launch-process`
  - `validate`：做测试验证，允许跑命令，但禁用 `save-file`
- 也就是说，从客户端原始设计看，子代理不是统一只读；它是按角色分权的。

### 从日志确认的现象

- 多份 `chat-stream` 日志显示，真实只读子代理请求体里往往根本没有 `sub-agent-explore` / `sub-agent-plan` / `sub-agent-code` / `sub-agent-validate` 这些子代理工具定义。
- 实际暴露的常见集合反而是：
  - `view`
  - `codebase-retrieval`
  - `view-range-untruncated`
  - `search-untruncated`
  - `read-process` / `write-process` / `kill-process` / `list-processes`
- 再叠加 `user_guidelines` 中明确写着：
  - `Do NOT modify any files`
  - `Do NOT run any commands or launch any processes`
- 因此，当上层模型要“创建项目 / 写文件 / mkdir / 保存 HTML”时，如果代理不主动裁剪这些终端工具并补出升级出口，就会出现看起来像“工具全失效”的表现：
  - 子代理反复 `view` / `codebase-retrieval`
  - 或者错误地继续尝试 `launch-process`
  - `Save File`、`str-replace-editor`、`launch-process` 无法合法完成任务
  - 最终停在只读探索模式

### 当前最合理的解释

- `explore` 被禁止写文件和跑命令，这件事本身不是 bug，而是客户端架构的刻意设计。
- 真正可疑的是“为什么主会话只拿到了 `explore/plan`，却没有同时拿到 `code/validate` 这类执行型子代理”。
- 这说明问题可能不只是模型选择错误，还可能是代理层或工具暴露链路漏了子代理能力，导致客户端原本支持的角色没有完整传到会话里。

### 对代理修复的意义

- 后续不要再把“`explore` 无法写文件”当成独立故障修。
- 更重要的是确认工具暴露是否完整：
  - 主会话的 `tool_definitions` 是否被代理裁剪过
  - 子代理工具集合是否有角色缺失
  - 是否只暴露了 `explore/plan`，遗漏了 `code/validate`
  - 是否还缺少“只读后切换到可写角色”的入口
  - 代理是否额外注入了客户端未声明的工具，进一步干扰模型决策

### 现阶段结论

- “子代理不能写”不是完整结论。
- 更精确的结论是：
  - `explore` 子代理按设计就是只读
  - 客户端原本可能同时支持可写、可验证的其他子代理角色
  - 当前代理接入链路里，主会话实际看到的子代理集合可能不完整，或者角色切换信息被漏发了
  - 这很可能就是“调用 agent 后工具异常”的根因之一

## 2026-05-07 子代理只读问题已确认根因

上面的调查记录保留了最初的观察过程，但最终代码审查已经确认：这次“子代理退化成只读 agent”的主因不在 `augment.mjs` 的角色设计，而在本地 Proxy 的 mock 逻辑。

### 已确认根因

- `proxy/src/fake-augment.ts`
  - `cloud-agents/create` 之前把 `capabilities` 硬编码成 `[]`
  - `cloud-agents/send-message` 在 agent 不存在时会走兜底对象，这个兜底对象同样把 `capabilities` 写死成 `[]`
  - `cloud-agents/send-message` 在调用方未显式传 `capabilities` 时，也可能覆盖掉已有 agent 的能力状态
- `proxy/src/augment-router.ts`
  - `agents/run-remote-tool` 的 `spawn-agent` 之前只返回了一个新的 `agent_id`
  - 这个新 agent 没有注册进 fake cloud-agent 的内存状态
  - 后续客户端拿这个 `agent_id` 调 `cloud-agents/send-message` 时，后端查不到，于是又落回“空能力兜底 agent”

### 为什么这会让子代理看起来只有只读能力

- 客户端会根据当前 agent 的 `capabilities` 和当前会话实际暴露的 `tool_definitions` 决定后续能不能写文件、跑命令、继续派生角色。
- Proxy 如果把 agent 状态注册得过弱，或者把当前会话里并不存在的工具错误暴露给模型，就会出现两类典型故障：
  - 模型在只读 `explore/plan` 子代理里反复调用 `save-file`、`str-replace-editor`、`launch-process`
  - 工具被拒绝后继续死循环，或者直接停住

### 2026-05-07 最终修复结果

- `proxy/src/augment-router.ts`
  - `spawn-agent` 现在会保留更完整的子代理状态，而不是只存一个空壳 capability。
  - 现在会把以下信息注册到 fake cloud-agent 状态里：
    - `session_config.mode`
    - `session_config.workspace_folder`
    - `session_config.information_request`
    - `session_config.agent_definition`
  - `mode` 会根据 `information_request` 和 `agent_definition` 粗略推断为 `explore | plan | code | validate`，供后续会话恢复使用。

- `proxy/src/openai-adapter.ts`
  - 不再无条件向上游模型注入假的 `save-file`。
    - 之前这会误导只读子代理去调用当前会话根本没有的写工具。
  - 新增“只读子代理严格工具可见性”：
    - 仅当当前会话明确是只读 `explore/plan` 子代理时，才会严格校验工具名是否真的存在于当前 `tool_definitions`。
    - 普通主会话仍保留原有的兼容修复逻辑，避免破坏既有行为。
  - 新增“真实只读工具表裁剪”：
    - 如果日志形态是“只有 `view` / `codebase-retrieval` / `read-process` 等基础工具，但 `user_guidelines` 明确禁止修改文件和跑命令”，代理会主动移除终端类工具：
      - `launch-process`
      - `read-process`
      - `write-process`
      - `kill-process`
      - `list-processes`
    - 同时强制补出两个升级出口：
      - `sub-agent-code`
      - `sub-agent-validate`
  - 新增“只读子代理误用恢复”：
    - 如果只读子代理里出现不可用的 `save-file` / `str-replace-editor`，自动改派到 `sub-agent-code`
    - 如果只读子代理里出现不可用的 `launch-process` / `read-process` / `write-process` / `kill-process`，自动改派到 `sub-agent-validate`
  - 这个恢复逻辑同时覆盖：
    - JSON 响应
    - 流式响应
    - repeated-failure 死循环恢复
    - stale `Tool call rejected` 文本恢复

### 回归测试

- 新增并通过：
  - `spawn-agent preserves inferred mode and session metadata`
  - `openai does not inject synthetic save-file into read-only sub-agent tool list`
  - `openai prunes terminal tools and injects code/validate for actual read-only client session`
  - `codex json unavailable save-file in read-only child switches to sub-agent-code`
  - `codex json unavailable launch-process in read-only child switches to sub-agent-validate`
  - `codex json actual read-only client launch-process is rerouted to sub-agent-validate`
- 当前验证结果：
  - `deno check proxy/src/openai-adapter.ts proxy/src/augment-router.ts proxy/src/fake-augment.ts proxy/src/openai-adapter_test.ts proxy/src/augment-router_test.ts`
  - `deno test -A proxy/src/augment-router_test.ts proxy/src/openai-adapter_test.ts`
  - 结果：`108 passed | 0 failed`

- 客户端原本会按 agent 的 `capabilities` 决定后续可用工具和权限。
- Proxy 把 `capabilities` 吞掉后，客户端看到的就是一个“没有能力声明”的 agent。
- 结果不是“模型自己选错了角色”，而是“代理返回的 agent 状态已经被剥夺了能力”，所以后续行为会退化成接近只读的模式。

### 已完成修复

- `proxy/src/fake-augment.ts`
  - 新增 agent 构造与复用逻辑，统一走 `ensureFakeAgent(...)`
  - `cloud-agents/create` 现在会保留请求体里的 `capabilities`
  - `cloud-agents/create` 现在会保留 `session_config`
  - `cloud-agents/send-message` 现在优先复用已存在 agent，且不会在未提供 `capabilities` 时把原值清空
- `proxy/src/augment-router.ts`
  - `spawn-agent` 现在不只是返回 `agent_id`
  - 同时会把新 agent 注册进 fake cloud-agent 状态表
  - 会保留 agent 名称、workspace、information_request、agent_definition 等会话信息

### 回归验证

- 已新增针对以下链路的测试：
  - `spawn-agent` 后，后续 `cloud-agents/send-message` 能命中同一个 agent
  - `cloud-agents/create` 会保留 `capabilities`
  - `cloud-agents/send-message` 不会清空已存在 agent 的 `capabilities`
- 当前本地验证结果：
  - `deno test -A proxy/src/augment-router_test.ts` 通过
  - `deno check proxy/src/augment-router.ts proxy/src/fake-augment.ts proxy/src/augment-router_test.ts` 通过
