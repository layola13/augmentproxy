# Cursor Agent Proxy

本目录是给 `/home/vscode/.local/bin/agent` 使用的本地代理。

它会模拟 Cursor Agent 需要的认证、模型列表和基础
AgentService，并把用户消息转发到 OpenAI-compatible `/chat/completions` 上游。

## Start

```bash
cd cursorproxy
deno task start
```

`deno task start` 会直接运行 TypeScript 源码。默认运行脚本会把 Cursor Agent
配置为 HTTP/1 AgentService；服务端仍保留 `http2` 端口作为可选 h2c fallback。

默认监听：

```text
HTTP/1 API: http://127.0.0.1:8777
HTTP/2 Agent: http://127.0.0.1:8778
```

配置优先读取 `cursorproxy/.env`，如果不存在同名 OpenAI 配置，会继续读取
`../proxy/.env`，方便复用当前 Augment proxy 的上游模型配置。

## Run Agent

仓库根目录提供了：

```bash
./run-cursor-agent-proxy.sh --print "Say hi"
```

脚本会执行 `which agent` 找到 `/home/vscode/.local/bin/agent`，并传入：

```bash
-e http://127.0.0.1:8777
--agent-endpoint http://127.0.0.1:8777
--api-key fake-cursorproxy-api-key
```

当前实现支持基础文本会话；复杂工具调用协议仍按空结果兜底。
