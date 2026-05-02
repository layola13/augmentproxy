# codexproxy

`codexproxy` 是一个给 Codex `/responses` 使用的中转代理，负责在请求发往上游模型前做提示词收敛、上下文裁剪和二次压缩。

## 功能

- 兼容 `POST /v1/responses` 和 `POST /responses`
- 提供 `GET /health` 健康检查
- 按 Codex `gpt-5.5` 指令模板收敛系统提示词
- 先做本地历史裁剪，再调用大模型做远程 compact
- 保留第一条用户需求里的非代码文本
- 仅允许压缩第一条用户消息中的代码块
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
- `ENABLE_COMPACT_MODEL=false`：关闭远程 compact helper，仅做本地安全裁剪后透传
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

- 最近用户输入不压缩
- 所有用户非代码文本都不会送去远程 compact
- 第一条任务需求中的非代码文本不压缩
- 第一条消息里只有 fenced code block 会被本地压缩
- 默认只保留最后 `CODEXPROXY_KEEP_RECENT_FUNCTION_CALL_PAIRS` 组真实工具调用历史
- 默认只保留最后 `CODEXPROXY_KEEP_RECENT_REASONING_ITEMS` 条真实 reasoning 历史
- `KEEP_FUNCTIONCALL_NAME=true` 时，旧工具调用会变成“方法名 + 参数名概览”的摘要消息，而不保留真实冗余参数和值
- 旧工具参数、工具结果、过期 reasoning 不再独立去重工具链
- 只在没有工具调用历史时，才会用 Codex compact 提示词做远程总结
