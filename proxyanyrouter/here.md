# ProxyAnyRouter MCP Bridge Plan

## Scope

This is a separate side project for `proxyanyrouter`.
It should not be mixed into the current `augmentproxy` repair stream until the MCP bridge is stable.

Goal:
- Make AnyRouter-like upstreams usable even when they do not support native MCP transport.
- Keep MCP execution local to the proxy side.
- Prefer real tool execution over prompt-only simulation.

Non-goals:
- Do not depend on upstream native `type="mcp"` support.
- Do not fake tool results when a real local MCP server exists.
- Do not couple the first version to Codex internals too tightly.

## Current State

Observed from the existing `augmentproxy` codebase:

- `anyrouter.md` only defines provider access (`base_url`, `wire_api = "responses"`). It does not define MCP servers or MCP execution behavior.
- `proxy/src/fake-augment.ts` returns empty MCP data for `settings/get-mcp-*`.
- `proxy/src/augment-router.ts` returns `{ tools: [] }` for `agents/list-remote-tools`.
- `proxy/src/openai-adapter.ts` only forwards `body.tool_definitions` to the upstream model. There is no MCP-specific synthesis layer today.

So the current blocker is not only "the upstream does not support MCP".
The proxy also does not yet advertise, normalize, or execute MCP tools.

## Key Decision

Recommended primary design:

1. Expose MCP tools to the client as normal remote tools.
2. Convert those MCP tools into ordinary function tools for the upstream model.
3. Execute MCP locally inside the proxy when the model calls them.
4. Feed tool results back through the existing tool-result loop.

This means the upstream model only needs ordinary function-calling support.
It does not need native MCP awareness.

## Why Prompt-Only `<mcp></mcp>` Is Not Enough

Using a system-prompt appendix like:

```xml
<mcp server="filesystem" tool="read_file">{...}</mcp>
```

can help as a fallback protocol, but it is not enough as the main design.

Problems:
- No schema registry.
- No argument validation before execution.
- No security boundary by default.
- No clean tool lifecycle or result channel.
- No reliable distinction between visible text and executable intent.
- Harder to stream safely.

Conclusion:
- Use `<mcp>...</mcp>` only as a fallback shim when ordinary function-calling is unavailable or broken.
- Do not make it the primary MCP bridge.

## Recommended Architecture

### 1. Independent config layer

Create a dedicated config source for `proxyanyrouter`, for example:

- `proxyanyrouter/mcp-servers.json`
- or `proxyanyrouter/mcp-servers.toml`

This file should be the source of truth for:
- server id
- launch command
- args
- env passthrough
- allowlisted tools
- timeout
- trust level

Optional later step:
- import or sync from Codex-style config if desired
- but do not make Codex config the hard dependency for v1

### 2. MCP registry

Add a registry module that:
- starts local MCP clients
- lists tools from each configured server
- normalizes tool metadata into a common structure

Suggested normalized shape:

```json
{
  "server": "filesystem",
  "tool": "read_file",
  "qualifiedName": "mcp__filesystem__read_file",
  "description": "Read a file from the local workspace",
  "inputSchema": {},
  "safety": "read",
  "timeoutMs": 30000
}
```

### 3. Client-facing MCP simulation

Implement real responses for:

- `settings/get-mcp-user-configs`
- `settings/get-mcp-tenant-configs`
- `agents/list-remote-tools`
- `agents/check-tool-safety`

Important point:
- the client must see non-empty MCP or remote-tool metadata before it can route those tools into later turns

### 4. Model-facing function bridge

Preferred mechanism:
- inject MCP tools into the upstream request as normal function tools
- use qualified names such as `mcp__<server>__<tool>`

Example:

```json
{
  "type": "function",
  "function": {
    "name": "mcp__filesystem__read_file",
    "description": "Read a file from the local workspace",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string" }
      },
      "required": ["path"]
    }
  }
}
```

Execution flow:

1. Upstream emits a normal function call.
2. Proxy detects `mcp__...` prefix.
3. Proxy maps the call to a local MCP server and tool.
4. Proxy executes the MCP request locally.
5. Proxy records the tool result in the same chat/tool history format already used by the proxy.
6. The next upstream turn continues with the real tool result.

### 5. Fallback text shim

Only if the upstream provider's function-calling is too unstable:

- append a small system prompt appendix describing `<mcp>` tags
- parse assistant text for those tags
- execute locally
- strip the raw tag block from user-visible output

This fallback should be:
- opt-in
- separately logged
- lower priority than normal tool calling

## Suggested Module Split

Do this work as a separate implementation stream.

Suggested files:

- `proxyanyrouter/README.md`
- `proxyanyrouter/here.md`
- `proxy/src/mcp-config.ts`
- `proxy/src/mcp-registry.ts`
- `proxy/src/mcp-bridge.ts`
- `proxy/src/mcp-remote-tools.ts`
- `proxy/src/mcp-fallback-parser.ts`

Suggested responsibility split:

- `mcp-config.ts`: load and validate MCP server config
- `mcp-registry.ts`: server lifecycle and tool discovery
- `mcp-remote-tools.ts`: client-facing tool metadata
- `mcp-bridge.ts`: execute qualified MCP tool calls
- `mcp-fallback-parser.ts`: optional `<mcp>` text shim

## Delivery Plan

### Phase 0: Instrumentation

Before building the bridge:
- log the exact payloads for `settings/get-mcp-*`
- log the exact payloads for `agents/list-remote-tools`
- log whether returned remote tools later appear in `body.tool_definitions`

This decides whether the Augment client already knows how to round-trip remote tools for us.

### Phase 1: Standalone proof of concept

Build a minimal local PoC:
- one MCP server
- one discovered tool
- one normalized schema
- one direct execution path from JSON input to MCP result

No prompt tricks in this phase.

### Phase 2: Client exposure

Return non-empty MCP and remote-tool metadata from the proxy.

Success condition:
- the client UI shows the remote or MCP tools as available

### Phase 3: Upstream bridge

Inject normalized MCP tools into upstream tool definitions and execute them locally on call.

Success condition:
- one real end-to-end MCP tool call completes through the upstream model

### Phase 4: Optional fallback shim

Add `<mcp>...</mcp>` only if:
- the provider fails on normal function tools
- or the provider drops tool calls too often

This must remain optional.

## Security Requirements

Do not skip this part.

Required controls:
- allowlist servers and tool names
- workspace path restrictions
- per-tool timeout
- output truncation
- secret redaction in logs
- explicit safety classification for write tools
- optional approval gate for high-risk tools

## Open Questions

These need answers before full implementation:

1. Does the Augment client re-insert remote tools into `tool_definitions`, or does it expect a separate execution API?
2. What exact JSON schema does the client expect from `agents/list-remote-tools` for full UI support?
3. Should MCP server processes be persistent, pooled, or per-request?
4. Should `proxyanyrouter` own its own MCP config permanently, or later support importing from Codex config?

## Recommended First Milestone

The first milestone should be small and real:

1. Add a dedicated MCP config file under `proxyanyrouter`.
2. Start one local MCP server.
3. Expose one tool via `agents/list-remote-tools`.
4. Map one qualified function tool like `mcp__filesystem__read_file`.
5. Execute one real request and return one real tool result.

If this milestone works, the rest is mostly protocol hardening and safety work.
