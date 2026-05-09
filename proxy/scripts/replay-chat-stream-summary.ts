import { forwardAugmentStream } from "../src/openai-adapter.ts";
import type {
  JsonObject,
  JsonValue,
  ProxyConfig,
  RequestContext,
} from "../src/types.ts";

function usage(): never {
  console.error(
    "Usage: deno run --allow-read scripts/replay-chat-stream-summary.ts <log-json-path>",
  );
  console.error(
    "Example: deno run --allow-read scripts/replay-chat-stream-summary.ts /tmp/augmentproxy-logs/2026-05-08/2026-05-08T11-19-02-191Z-POST-chat-stream.json",
  );
  Deno.exit(1);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function valueText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
  return normalized;
}

function pathDirname(path: string): string | undefined {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized.startsWith("/") ? "/" : undefined;
  return normalized.slice(0, index);
}

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function workspaceMarkers(): string[] {
  return [
    "build.zig",
    "package.json",
    "deno.json",
    "deno.jsonc",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    ".git",
  ];
}

function findWorkspaceRoot(path: string): string | undefined {
  let candidate = normalizePath(path);
  if (fileExists(candidate)) {
    candidate = pathDirname(candidate) ?? candidate;
  }
  if (!directoryExists(candidate)) return undefined;
  for (let depth = 0; depth < 8; depth += 1) {
    for (const marker of workspaceMarkers()) {
      if (pathExists(`${candidate}/${marker}`)) return candidate;
    }
    const parent = pathDirname(candidate);
    if (!parent || parent === candidate) break;
    candidate = parent;
  }
  return directoryExists(candidate) ? candidate : undefined;
}

function absolutePathsFromText(text: string): string[] {
  const output: string[] = [];
  for (const match of text.matchAll(/\/[^\s"'`<>:]+(?:\/[^\s"'`<>:]+)*/g)) {
    const candidate = normalizePath(match[0].replace(/[),.;]+$/g, ""));
    if (candidate && candidate !== "/") output.push(candidate);
  }
  return output;
}

function pushIfText(output: string[], value: JsonValue | undefined): void {
  const rendered = valueText(value).trim();
  if (rendered) output.push(rendered);
}

function summaryTextEntries(
  summary: JsonObject,
): { text: string; priority: number }[] {
  const output: { text: string; priority: number }[] = [];
  const push = (value: JsonValue | undefined, priority: number) => {
    const rendered = valueText(value).trim();
    if (rendered) output.push({ text: rendered, priority });
  };

  push(summary.path, 120);
  push(summary.current_user_text, 120);
  push(summary.message_summary, 90);
  const chatHistory = asObject(summary.chat_history);
  for (const item of asArray(chatHistory?.recent)) {
    const record = asObject(item);
    if (!record) continue;
    push(record.request_text, 70);
    push(record.response_text, 60);
    for (const bundle of [record.request_nodes, record.response_nodes]) {
      const nodeBundle = asObject(bundle);
      if (!nodeBundle) continue;
      for (const textNode of asArray(nodeBundle.text_nodes)) {
        push(textNode, 50);
      }
      for (const result of asArray(nodeBundle.tool_results)) {
        const toolResult = asObject(result);
        if (!toolResult) continue;
        push(toolResult.content_summary, 25);
      }
    }
  }
  return output;
}

function inferWorkspacePath(summary: JsonObject): string {
  const explicitPath = valueText(summary.path).trim();
  if (explicitPath && pathExists(explicitPath)) {
    return findWorkspaceRoot(explicitPath) ?? normalizePath(explicitPath);
  }

  const texts = summaryTextEntries(summary);
  for (const entry of texts) {
    const text = entry.text;
    const explicitMatch = text.match(
      /\b(?:workspace root|workspace folder|current workspace\/path from the client)\s*:\s*(\/[^\s"'`<>]+)/i,
    );
    if (explicitMatch?.[1] && pathExists(explicitMatch[1])) {
      return findWorkspaceRoot(explicitMatch[1]) ??
        normalizePath(explicitMatch[1]);
    }
  }

  const candidates: { path: string; score: number }[] = [];
  for (const entry of texts) {
    for (const candidate of absolutePathsFromText(entry.text)) {
      if (!pathExists(candidate)) continue;
      const resolved = findWorkspaceRoot(candidate) ??
        (fileExists(candidate) ? pathDirname(candidate) ?? candidate : candidate);
      const normalized = normalizePath(resolved);
      if (!normalized || normalized === "/") continue;
      let score = entry.priority + normalized.split("/").length;
      if (normalized.includes("/projects/")) score += 20;
      if (pathExists(`${normalized}/build.zig`)) score += 10;
      if (pathExists(`${normalized}/package.json`)) score += 10;
      if (pathExists(`${normalized}/deno.json`)) score += 10;
      if (pathExists(`${normalized}/Cargo.toml`)) score += 10;
      candidates.push({ path: normalized, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.path.length - a.path.length);
  if (candidates[0]?.path) {
    return candidates[0].path;
  }

  return Deno.cwd();
}

function toolSchema(name: string): JsonObject {
  switch (name) {
    case "view":
      return {
        type: "object",
        properties: { path: { type: "string" }, type: { type: "string" } },
        required: ["path"],
      };
    case "codebase-retrieval":
      return {
        type: "object",
        properties: {
          workspace_folder: { type: "string" },
          information_request: { type: "string" },
        },
        required: ["information_request"],
      };
    case "launch-process":
      return {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          wait: { type: "boolean" },
          max_wait_seconds: { type: "number" },
        },
        required: ["command"],
      };
    case "save-file":
      return {
        type: "object",
        properties: {
          path: { type: "string" },
          file_content: { type: "string" },
        },
        required: ["path", "file_content"],
      };
    case "str-replace-editor":
      return {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      };
    case "read-process":
    case "kill-process":
      return {
        type: "object",
        properties: { terminal_id: { type: "number" } },
        required: ["terminal_id"],
      };
    case "write-process":
      return {
        type: "object",
        properties: {
          terminal_id: { type: "number" },
          input_text: { type: "string" },
        },
        required: ["terminal_id"],
      };
    default:
      if (name.startsWith("sub-agent-")) {
        return {
          type: "object",
          properties: {
            action: { type: "string" },
            name: { type: "string" },
            instruction: { type: "string" },
          },
          required: ["action"],
        };
      }
      return { type: "object", properties: {} };
  }
}

function buildToolDefinitions(summary: JsonObject): JsonObject[] {
  const defs = asObject(summary.tool_definitions);
  const names = asArray(defs?.names)
    .map((item) => valueText(item).trim())
    .filter(Boolean);
  return names.map((name) => ({
    name,
    description: `${name} replay tool`,
    input_schema: toolSchema(name),
  }));
}

function toolArgumentsJson(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return JSON.stringify(parsed);
      }
    } catch {
      // Fall through to generic placeholder.
    }
    return "{}";
  }
  const objectValue = asObject(value);
  return JSON.stringify(objectValue ?? {});
}

function convertSummaryNodeBundle(
  bundle: JsonObject | undefined,
): JsonObject[] {
  if (!bundle) return [];
  const nodes: JsonObject[] = [];
  let nextId = 1;
  for (const item of asArray(bundle.text_nodes)) {
    const content = valueText(item).trim();
    if (!content) continue;
    nodes.push({
      id: nextId++,
      type: 0,
      text_node: { content },
    });
  }
  for (const item of asArray(bundle.tool_uses)) {
    const toolUse = asObject(item);
    if (!toolUse) continue;
    const name = valueText(toolUse.name).trim();
    if (!name) continue;
    const id = valueText(toolUse.id).trim() || `summary_tool_${nextId}`;
    nodes.push({
      id: nextId++,
      type: 5,
      tool_use: {
        tool_name: name,
        tool_use_id: id,
        input_json: toolArgumentsJson(toolUse.args),
      },
    });
  }
  for (const item of asArray(bundle.tool_results)) {
    const toolResult = asObject(item);
    if (!toolResult) continue;
    const id = valueText(toolResult.id).trim();
    const content = valueText(toolResult.content_summary).trim();
    if (!id || !content) continue;
    nodes.push({
      id: nextId++,
      type: 1,
      tool_result_node: {
        tool_use_id: id,
        content,
      },
    });
  }
  return nodes;
}

function currentRequestText(
  lastRecord: JsonObject,
  summary: JsonObject,
): string {
  const requestText = valueText(lastRecord.request_text).trim();
  if (requestText) return requestText;
  const requestNodes = asObject(lastRecord.request_nodes);
  const firstText = valueText(asArray(requestNodes?.text_nodes)[0]).trim();
  if (firstText) return firstText;
  return "";
}

function buildIdeStateNode(path: string): JsonObject {
  return {
    id: 9999,
    type: 4,
    ide_state_node: {
      workspace_folders: [{ repository_root: path, folder_root: path }],
      workspace_folders_unchanged: true,
      current_terminal: {
        terminal_id: 0,
        current_working_directory: path,
      },
    },
  };
}

function buildReplayBody(summary: JsonObject): JsonObject {
  const chatHistory = asObject(summary.chat_history);
  const recent = asArray(chatHistory?.recent)
    .map((item) => asObject(item))
    .filter((item): item is JsonObject => Boolean(item));
  if (recent.length === 0) {
    throw new Error("body_summary.chat_history.recent is empty; nothing to replay.");
  }
  const last = recent[recent.length - 1];
  const workspacePath = inferWorkspacePath(summary);
  const history = recent.slice(0, -1).map((record) => ({
    request_id: valueText(record.request_id).trim(),
    request_text: valueText(record.request_text).trim(),
    response_text: valueText(record.response_text).trim(),
    request_nodes: convertSummaryNodeBundle(asObject(record.request_nodes)),
    response_nodes: convertSummaryNodeBundle(asObject(record.response_nodes)),
  }));
  const currentNodes = convertSummaryNodeBundle(asObject(last.request_nodes));
  if (!currentNodes.some((node) => Boolean(asObject(node.ide_state_node)))) {
    currentNodes.unshift(buildIdeStateNode(workspacePath));
  }
  return {
    path: workspacePath,
    mode: valueText(summary.mode).trim() || "CLI_AGENT",
    message: currentRequestText(last, summary),
    tool_definitions: buildToolDefinitions(summary),
    chat_history: history,
    nodes: currentNodes,
  };
}

function summaryResponseText(lastRecord: JsonObject): string {
  const responseNodes = asObject(lastRecord.response_nodes);
  const textNodes = asArray(responseNodes?.text_nodes)
    .map((item) => valueText(item).trim())
    .filter(Boolean);
  if (textNodes.length > 0) return textNodes.join("\n");
  return valueText(lastRecord.response_text).trim();
}

function summaryResponseToolCalls(lastRecord: JsonObject): JsonObject[] {
  const responseNodes = asObject(lastRecord.response_nodes);
  return asArray(responseNodes?.tool_uses)
    .map((item, index) => {
      const toolUse = asObject(item);
      if (!toolUse) return undefined;
      const name = valueText(toolUse.name).trim();
      if (!name) return undefined;
      return {
        id: valueText(toolUse.id).trim() || `summary_call_${index}`,
        index,
        type: "function",
        function: {
          name,
          arguments: toolArgumentsJson(toolUse.args),
        },
      };
    })
    .filter((item): item is JsonObject => Boolean(item));
}

function replayConfig(): ProxyConfig {
  const defaultChannel = {
    baseUrl: "https://example.test/v1",
    apiKeys: ["test-openai-key"],
    model: "test-model",
  };
  return {
    port: 0,
    switchApi: "OPENAI",
    activeChannel: "default",
    expertChannel: "",
    channels: { default: defaultChannel },
    modelMapping: {},
    openaiBaseUrl: defaultChannel.baseUrl,
    codexBaseUrl: "https://codex.example.test/v1",
    openaiApiKeys: [...defaultChannel.apiKeys],
    codexApiKey: "test-codex-key",
    openaiModel: "test-model",
    codexModel: "test-codex-model",
    openaiUserAgent: "replay-summary-script",
    upstreamAppName: "ReplaySummaryScript",
    sanitizeUpstreamPrompts: false,
    augmentModelContextTokens: 128000,
    augmentModelMaxOutputTokens: 4096,
    augmentHistoryTailTokens: 16000,
    augmentHistoryMaxChars: 64000,
    augmentHistorySummaryPrompt: "",
    fakeAugmentEmail: "replay@example.test",
    fakeAugmentUserId: "replay-user",
    requestLogDir: "",
    indexingMode: "off",
    embedBaseUrl: "https://embed.example.test/v1",
    embedApiKeys: ["test-embed-key"],
    embedModel: "test-embed-model",
    embedDimensions: 1536,
    qdrantUrl: "http://127.0.0.1:6333",
    qdrantCollection: "replay",
    indexChunkChars: 1800,
    indexChunkOverlap: 200,
    logLevel: "error",
  };
}

function parseStreamObjects(text: string): JsonObject[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as JsonObject);
}

function toolNamesFromRequest(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const output: string[] = [];
  for (const item of tools) {
    const tool = asObject(item);
    const fn = asObject(tool?.function);
    const name = valueText(fn?.name).trim();
    if (name) output.push(name);
  }
  return output;
}

const logPath = Deno.args[0];
if (!logPath || logPath === "-h" || logPath === "--help") usage();

const raw = JSON.parse(await Deno.readTextFile(logPath)) as JsonObject;
const summary = asObject(raw.body_summary);
if (!summary) throw new Error("Log file does not contain body_summary.");

const chatHistory = asObject(summary.chat_history);
const recent = asArray(chatHistory?.recent)
  .map((item) => asObject(item))
  .filter((item): item is JsonObject => Boolean(item));
if (recent.length === 0) {
  throw new Error("body_summary.chat_history.recent is empty.");
}
const last = recent[recent.length - 1];
const replayBody = buildReplayBody(summary);
const requestId = valueText(raw.requestId).trim() || "summary-replay";
const requestPath = typeof raw.path === "string" && raw.path.trim()
  ? raw.path.trim()
  : "/chat-stream";
const upstreamText = summaryResponseText(last);
const upstreamToolCalls = summaryResponseToolCalls(last);
const capturedRequests: JsonObject[] = [];

const ctx: RequestContext = {
  requestId,
  method: valueText(raw.method).trim() || "POST",
  url: new URL(`http://localhost${requestPath}`),
  path: requestPath,
  headers: new Headers(),
  body: replayBody,
  rawBody: JSON.stringify(replayBody),
};

console.log("LOG", logPath);
console.log("MODE", "body_summary");
console.log("REQUEST", requestId, ctx.method, ctx.path);
console.log("INFERRED_PATH", valueText(replayBody.path));
console.log("UPSTREAM_TEXT", upstreamText || "<empty>");
console.log("UPSTREAM_TOOL_CALLS", String(upstreamToolCalls.length));

const originalFetch = globalThis.fetch;
globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
  capturedRequests.push(JSON.parse(String(init?.body ?? "{}")) as JsonObject);
  const delta: JsonObject = {};
  if (upstreamText) delta.content = upstreamText;
  if (upstreamToolCalls.length > 0) delta.tool_calls = upstreamToolCalls;
  return Promise.resolve(
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
}) as typeof fetch;

try {
  const response = await forwardAugmentStream(replayConfig(), ctx);
  const streamText = await response.text();
  const objects = parseStreamObjects(streamText);
  const upstreamRequest = capturedRequests[0] ?? {};
  console.log("REQUEST_TOOL_CHOICE", valueText(upstreamRequest.tool_choice));
  console.log("REQUEST_TOOLS", toolNamesFromRequest(upstreamRequest).join(","));

  let toolNodeCount = 0;
  for (const item of objects) {
    const nodes = asArray(item.nodes);
    for (const node of nodes) {
      const nodeRecord = asObject(node);
      const toolUse = nodeRecord ? asObject(nodeRecord.tool_use) : undefined;
      if (toolUse) {
        toolNodeCount += 1;
        console.log(
          "TOOL",
          valueText(toolUse.tool_name),
          valueText(toolUse.tool_use_id),
          valueText(toolUse.input_json).slice(0, 220),
        );
      }
    }
    const text = valueText(item.text).trim();
    if (text) console.log("TEXT", text.slice(0, 220));
    const responseText = valueText(item.response_text).trim();
    if (responseText) console.log("RESP", responseText.slice(0, 220));
  }
  console.log("DONE", `tool_nodes=${toolNodeCount}`);
} finally {
  globalThis.fetch = originalFetch;
}
