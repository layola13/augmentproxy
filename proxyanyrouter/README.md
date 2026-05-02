# ProxyAnyRouter

独立的 `/v1/responses` MCP bridge，用来给不支持 Codex MCP namespace/function-call 回环的上游做本地补桥。

## 目标

- 对齐 Codex 的 `wire_api = "responses"`。
- 接受带 namespace 的 MCP tools 请求。
- 在转发到上游前，把本地 MCP namespace 工具扁平化成普通 `function` tools。
- 当上游返回对应 `function_call` 时，在本地执行工具，并用 `previous_response_id + function_call_output` 继续回环。

## 启动

```bash
cd /home/vscode/projects/augmentproxy/proxyanyrouter
deno task start
```

默认环境变量：

```env
PROXYANYROUTER_PORT=8876
PROXYANYROUTER_UPSTREAM_URL=http://127.0.0.1:8877/v1/responses
PROXYANYROUTER_MCP_CONFIG=/home/vscode/projects/augmentproxy/proxyanyrouter/mcp-tools.json
PROXYANYROUTER_HEARTBEAT_MS=5000
PROXYANYROUTER_MAX_STEPS=6
PROXYANYROUTER_CONTINUATION_MODE=replay
```

如果上游需要独立鉴权，可以加：

```env
PROXYANYROUTER_UPSTREAM_API_KEY=sk-...
```

## Codex 配置示例

把 `anyrouter.md` 里的 `base_url` 改为本地 bridge：

```toml
[model_providers.anyrouter_mcp_proxy]
name = "AnyRouter MCP Proxy"
base_url = "http://127.0.0.1:8876/v1"
wire_api = "responses"
```

这样 Codex 仍然走 `/v1/responses`，但 namespace MCP 工具会先经过本地 bridge，再转到真实上游。

## 测试

```bash
cd /home/vscode/projects/augmentproxy/proxyanyrouter
bash test-mcp-bridge.sh
```

测试覆盖：

- 客户端请求里的 `namespace` 工具被扁平化后才发给上游
- 上游返回 `function_call`
- bridge 本地读取 `anyrouter.md`
- 第二跳请求带 `function_call_output`
- 第二跳续接兼容 `replay` 和 `previous_response_id`
- 客户端最终收到 `wire_api = responses`

## AnyRouter 兼容说明

- `tool_search` 会在转发到上游前被剥离，因为 AnyRouter 当前会对这类工具返回 `520` 空体。
- 非桥接请求现在走实时透传，不再等完整上游 SSE 收完才回给客户端。
- 本地 MCP bridge 默认使用 `PROXYANYROUTER_CONTINUATION_MODE=replay`，第二跳会把首跳 `function_call` 和 `function_call_output` 直接回放到 `input`，避免 AnyRouter 对 `previous_response_id` 报错。
- 如果后续切回支持 `previous_response_id` 的上游，可以把 `PROXYANYROUTER_CONTINUATION_MODE` 改成 `previous_response_id`。
