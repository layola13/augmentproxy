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
