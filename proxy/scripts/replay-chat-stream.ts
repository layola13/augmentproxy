import { forwardAugmentStream } from "../src/openai-adapter.ts";
import type { JsonObject, JsonValue, ProxyConfig, RequestContext } from "../src/types.ts";

function usage(): never {
  console.error(
    "Usage: deno run --allow-env --allow-read scripts/replay-chat-stream.ts <log-json-path> [launch-command]",
  );
  console.error(
    "Example: deno run --allow-env --allow-read scripts/replay-chat-stream.ts /tmp/augmentproxy-logs/2026-05-06/2026-05-06T02-58-53-055Z-POST-chat-stream.json",
  );
  Deno.exit(1);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function valueText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

function extractBody(logRecord: JsonObject): JsonObject {
  const body = logRecord.body;
  if (asObject(body)) return asObject(body)!;

  if (typeof body === "string") {
    if (body.startsWith("[BODY_TOO_LARGE")) {
      const summary = asObject(logRecord.body_summary);
      const summaryHint = summary
        ? ` body_summary keys: ${Object.keys(summary).join(", ")}`
        : "";
      throw new Error(
        `Log body was truncated and cannot be replayed from this file (${body}).${summaryHint}`,
      );
    }
    const parsed = parseJsonObject(body.trim());
    if (parsed) return parsed;
  }

  for (const key of ["request_body", "payload", "raw_body", "rawBody"]) {
    const candidate = logRecord[key];
    const objectCandidate = asObject(candidate);
    if (objectCandidate) return objectCandidate;
    if (typeof candidate === "string") {
      const parsed = parseJsonObject(candidate.trim());
      if (parsed) return parsed;
    }
  }

  throw new Error("Could not extract replayable JSON body from log file.");
}

function pathWithLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function buildHeaders(record: JsonObject): Headers {
  const output = new Headers();
  const headers = asObject(record.headers);
  if (!headers) return output;
  for (const [key, value] of Object.entries(headers)) {
    const rendered = valueText(value).trim();
    if (rendered) output.set(key, rendered);
  }
  return output;
}

function isAllowedAbsoluteDirectory(path: string): boolean {
  if (!path || !path.startsWith("/")) return false;
  try {
    const info = Deno.statSync(path);
    return info.isDirectory;
  } catch {
    return false;
  }
}

function inferWorkingDirectory(body: JsonObject): string {
  const explicitPath = typeof body.path === "string" ? body.path.trim() : "";
  if (isAllowedAbsoluteDirectory(explicitPath)) return explicitPath;
  return Deno.cwd();
}

function availableToolNames(body: JsonObject): Set<string> {
  const result = new Set<string>();
  const rawDefs = body.tool_definitions;
  if (!Array.isArray(rawDefs)) return result;
  for (const def of rawDefs) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const name = valueText((def as JsonObject).name).trim();
    if (name) result.add(name);
  }
  return result;
}

function buildMockToolCall(
  body: JsonObject,
  launchCommand: string,
  cwd: string,
): { name: string; arguments: JsonObject } {
  const tools = availableToolNames(body);
  if (tools.has("launch-process")) {
    return {
      name: "launch-process",
      arguments: {
        command: launchCommand,
        cwd,
        wait: true,
        max_wait_seconds: 60,
      },
    };
  }
  if (tools.has("view")) {
    return {
      name: "view",
      arguments: {
        path: cwd,
        type: "directory",
      },
    };
  }
  return {
    name: "launch-process",
    arguments: {
      command: launchCommand,
      cwd,
      wait: true,
      max_wait_seconds: 60,
    },
  };
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
    openaiUserAgent: "replay-script",
    upstreamAppName: "ReplayScript",
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

const logPath = Deno.args[0];
if (!logPath || logPath === "-h" || logPath === "--help") usage();

const launchCommand = Deno.args[1] ?? "pwd && ls -la";
const logText = await Deno.readTextFile(logPath);
const logRecord = JSON.parse(logText) as JsonObject;
const body = extractBody(logRecord);
const requestPath = pathWithLeadingSlash(valueText(logRecord.path) || "chat-stream");
const requestId = valueText(logRecord.requestId).trim() || "replay";
const cwd = inferWorkingDirectory(body);
const mockTool = buildMockToolCall(body, launchCommand, cwd);

const ctx: RequestContext = {
  requestId,
  method: valueText(logRecord.method).trim() || "POST",
  url: new URL(`http://localhost${requestPath}`),
  path: requestPath,
  headers: buildHeaders(logRecord),
  body,
  rawBody: JSON.stringify(body),
};

console.log("LOG", logPath);
console.log("REQUEST", requestId, ctx.method, ctx.path);
console.log("MOCK_LAUNCH_COMMAND", launchCommand);
console.log("MOCK_CWD", cwd);
console.log("MOCK_TOOL", mockTool.name);

const originalFetch = globalThis.fetch;
globalThis.fetch = (() =>
  Promise.resolve(
    new Response(
      [
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                id: "call_replay_launch",
                index: 0,
                type: "function",
                function: {
                  name: mockTool.name,
                  arguments: JSON.stringify(mockTool.arguments),
                },
              }],
            },
          }],
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    ),
  )) as typeof fetch;

try {
  const response = await forwardAugmentStream(replayConfig(), ctx);
  const streamText = await response.text();

  let toolNodeCount = 0;
  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const item = JSON.parse(trimmed) as JsonObject;
    const nodes = Array.isArray(item.nodes) ? item.nodes : [];
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
      const content = nodeRecord ? valueText(nodeRecord.content).trim() : "";
      if (content) console.log("TEXTNODE", content.slice(0, 220));
    }
    const text = valueText(item.text).trim();
    if (text) console.log("TEXT", text.slice(0, 220));
    const responseText = valueText(item.response_text).trim();
    if (responseText) console.log("RESP", responseText.slice(0, 220));
  }
  console.log("DONE tool_nodes=", toolNodeCount);
} finally {
  globalThis.fetch = originalFetch;
}
