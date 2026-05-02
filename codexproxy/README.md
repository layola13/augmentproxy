# codexproxy

`codexproxy` 是一个给 Codex `/responses` 使用的中转代理。当前稳定模式下，它只裁剪和压缩旧 `Tool History`，其他上下文尽量原样透传。

## 功能

- 兼容 `POST /v1/responses` 和 `POST /responses`
- 兼容 `POST /v1/responses/compact` 和 `POST /responses/compact`
- 提供 `GET /health` 健康检查
- 只处理旧 `function_call` / `function_call_output` 历史
- 先做本地工具历史裁剪，再按需调用大模型做远程 compact
- 用户消息、reasoning、continuation 尾巴、`instructions` 目前不改写
- 默认只在上下文达到阈值且存在 Tool History 时才启动压缩链路
- 实时打印原始上下文 tokens、处理后 tokens、压缩比例
- 在 `logs/recent-messages.json` 中滚动保留最近 1000 条消息

## 目录

- 入口服务：`src/server.ts`
- 配置示例：`.env.example`
- 补充说明：`here.md`

## 环境变量

必须配置：

- `CODEX_BASE_URL`
- `CODEX_API_KEY`
- `LITE_BASE_URL`
- `LITE_API_KEY`
- `LITE_MODEL`
- `CODEX_DEFAULT_MODEL`

常用可选项：

- `PROXY_PORT`
- `API_KEY`
- `CODEX_CODE_MODEL`
- `CODEX_PLAN_MODEL`
- `CODEX_DOC_MODEL`
- `CODEXPROXY_CODEX_ROOT`
- `CODEXPROXY_LOG_DIR`
- `CODEXPROXY_REQUEST_TIMEOUT_MS`
- `ENABLE_COMPACT_MODEL`
- `CODEXPROXY_LOCAL_PRUNE_MIN_TOKENS`
- `CODEXPROXY_KEEP_RECENT_FUNCTION_CALL_PAIRS`
- `CODEXPROXY_KEEP_RECENT_REASONING_ITEMS`
- `KEEP_FUNCTIONCALL_NAME`

也兼容以下别名：

- `CODEX_DEFAULT_MODEL` 兼容 `DEFAULT_MODEL`
- `CODEX_CODE_MODEL` 兼容 `CODE_MODEL`
- `CODEX_PLAN_MODEL` 兼容 `PLAN_MODEL`
- `CODEX_DOC_MODEL` 兼容 `DOC_MODEL`
- `API_KEY` 也可写成 `PROXY_API_KEY` 或 `CODEXPROXY_ACCESS_KEY`

配置分工：

- `CODEX_*`：最终 Codex 请求使用的上游
- `LITE_*`：远程 compact 压缩使用的轻量上游
- `API_KEY`：客户端访问本代理时的鉴权 key，不会转发给上游
- `ENABLE_COMPACT_MODEL=false`：关闭远程 compact helper，仅做本地工具历史裁剪后透传
- `CODEXPROXY_LOCAL_PRUNE_MIN_TOKENS`：只有上下文达到该 token 阈值且存在 Tool History 时才启用裁剪和远程 compact
- `CODEXPROXY_KEEP_RECENT_FUNCTION_CALL_PAIRS`：历史里保留最后多少组真实 `function_call` / `function_call_output`
- `CODEXPROXY_KEEP_RECENT_REASONING_ITEMS`：历史里保留最后多少条真实 `reasoning`
- `KEEP_FUNCTIONCALL_NAME=true`：旧 `function_call` 不直接删除，改为保留“方法名 + 参数名概览”的摘要

## 启动

先准备配置文件：

```bash
cd /home/vscode/projects/augmentproxy/codexproxy
cp .env.example .env
```

然后启动服务：

```bash
cd /home/vscode/projects/augmentproxy/codexproxy
deno task start
```

推荐直接用脚本重启，脚本会先清理本项目旧的代理进程，再后台拉起新实例：

```bash
cd /home/vscode/projects/augmentproxy/codexproxy
./start.sh
```

## 检查与测试

```bash
cd /home/vscode/projects/augmentproxy/codexproxy
deno task check
deno task test
```

## 接口

### 健康检查

```bash
curl http://127.0.0.1:8878/health
```

### Responses 入口

- `POST /v1/responses`
- `POST /responses`

调用代理时需要带代理鉴权，支持：

```bash
Authorization: Bearer $API_KEY
```

或者：

```bash
x-api-key: $API_KEY
```

## 模型选择

客户端请求里的 `model` 默认透传到 `CODEX_*` 上游。

只有当客户端传的是 `"auto"`，代理才会自行选择模型：

- 命中文档/说明/SDK/README 信号：走 `CODEX_DOC_MODEL`
- 命中代码/报错/文件路径/实现信号：走 `CODEX_CODE_MODEL`
- 命中方案/规划/设计/调研信号：走 `CODEX_PLAN_MODEL`
- 都不命中：走 `CODEX_DEFAULT_MODEL`

## 日志

默认日志目录由 `CODEXPROXY_LOG_DIR` 控制，默认值是 `./logs`。

主要日志内容：

- 每个请求会创建单独目录，保存请求体、压缩结果、上游请求和上游响应
- `events.jsonl` 保存事件流日志
- `recent-messages.json` 滚动保留最近 1000 条 `message` 类型上下文
- 服务会在控制台实时打印：
  - 客户端原始 req
  - 最终选择的模型与选择原因
  - 原始上下文 token 数
  - 本地裁剪后 token 数
  - 最终发送前 token 数
  - `after/before` 压缩百分比

## 压缩规则

- 默认阈值以下不压缩，直接透传
- 没有 Tool History 时不压缩，直接透传
- 当前只会裁剪旧 `function_call` / `function_call_output`
- `update_plan` / todolist 历史永远保留原文，不进入远程 compact
- 默认只保留最后 `CODEXPROXY_KEEP_RECENT_FUNCTION_CALL_PAIRS` 组真实工具调用历史
- `KEEP_FUNCTIONCALL_NAME=true` 时，旧工具调用会变成“方法名 + 参数名概览”的本地摘要消息
- 开启远程 compact 时，只会把被移除的旧 Tool History 发给 compact helper，总结后再插回原位置
- 用户消息、reasoning、continuation 尾巴、`instructions` 当前不做压缩或改写
- Codex 客户端手动 `/compact` 走的是 `/responses/compact`，代理对该端点完全直通，不拦截不改写
