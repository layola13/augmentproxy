import type {
  JsonObject,
  JsonValue,
  ProxyConfig,
  RequestContext,
} from "./types.ts";

const SENSITIVE_KEYS = [
  "authorization",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "apiKey",
  "token",
  "secret",
  "password",
  "client_secret",
];

const LARGE_BODY_BYTES = 50_000;
const SUMMARY_STRING_LIMIT = 700;
const ARG_STRING_LIMIT = 300;

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((sensitive) =>
    lower.includes(sensitive.toLowerCase())
  );
}

export function redact(value: JsonValue, depth = 0): JsonValue {
  // Hard limit on recursion depth to prevent event loop blocking.
  if (depth > 5) return "[NESTED_OBJECT_TRUNCATED]";

  if (Array.isArray(value)) {
    if (value.length > 20) return `[ARRAY_TOO_LARGE: ${value.length} items]`;
    return value.map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    const keys = Object.keys(value);
    if (keys.length > 50) return `[OBJECT_TOO_LARGE: ${keys.length} keys]`;

    for (const [key, nested] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === "chat_history" ||
        lowerKey === "nodes" ||
        lowerKey === "messages" ||
        lowerKey === "file_content" ||
        lowerKey === "input"
      ) {
        output[key] = "[SKIPPED_FOR_PERFORMANCE]";
        continue;
      }
      output[key] = isSensitive(key) ? "[REDACTED]" : redact(nested, depth + 1);
    }
    return output;
  }
  return value;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactString(value: string, max = SUMMARY_STRING_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}... [truncated ${
    normalized.length - max
  } chars]`;
}

function compactValue(
  value: JsonValue | undefined,
  max = SUMMARY_STRING_LIMIT,
): string {
  return compactString(stringValue(value), max);
}

function firstString(record: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function inferAgentRole(userGuidelines: string): string {
  const lower = userGuidelines.toLowerCase();
  if (!lower) return "main";
  if (lower.includes("askexpert") || lower.includes("expert")) {
    return "askexpert";
  }
  if (lower.includes("judge")) return "judge";
  if (lower.includes("validat")) return "validate";
  if (
    lower.includes("documentation") || lower.includes("system wiki") ||
    lower.includes("docs")
  ) return "docs";
  if (
    lower.includes("code implementation") ||
    lower.includes("create and edit files") ||
    lower.includes("concrete code changes")
  ) return "code";
  if (
    lower.includes("read-only") || lower.includes("do not modify any files")
  ) return "read-only";
  if (lower.includes("implementation plans") || lower.includes("planning")) {
    return "plan";
  }
  if (
    lower.includes("gathers information") || lower.includes("investigation")
  ) return "explore";
  if (lower.includes("sub-agent")) return "sub-agent";
  return "main";
}

function toolNameFromDefinition(value: JsonValue): string {
  const record = asObject(value);
  if (!record) return "unknown";
  const direct = firstString(record, ["name", "tool_name"]);
  if (direct) return direct;
  const fn = asObject(record.function);
  if (fn) {
    const name = firstString(fn, ["name", "tool_name"]);
    if (name) return name;
  }
  const definition = asObject(record.tool_definition);
  if (definition) {
    const name = firstString(definition, ["name", "tool_name"]);
    if (name) return name;
  }
  return "unknown";
}

function summarizeToolDefinitions(value: JsonValue | undefined): JsonObject {
  const definitions = asArray(value);
  const names = definitions.map(toolNameFromDefinition).filter((name) =>
    name !== "unknown"
  );
  return {
    count: definitions.length,
    names: names.slice(0, 80),
    truncated: names.length > 80,
  };
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function safeArgumentSummaryValue(key: string, value: JsonValue): JsonValue {
  if (isSensitive(key)) return "[REDACTED]";
  const lower = key.toLowerCase();
  if (
    lower.includes("content") || lower.includes("contents") ||
    lower === "input" ||
    lower === "data" || lower === "body" || lower === "text" ||
    lower === "new_str" ||
    lower === "old_str"
  ) {
    return `[STRING:${stringValue(value).length} chars]`;
  }
  if (typeof value === "string") return compactString(value, ARG_STRING_LIMIT);
  if (
    typeof value === "number" || typeof value === "boolean" || value === null
  ) return value;
  if (Array.isArray(value)) return `[ARRAY:${value.length} items]`;
  if (value && typeof value === "object") {
    return `[OBJECT:${Object.keys(value).length} keys]`;
  }
  return "";
}

function summarizeToolArguments(input: JsonValue | undefined): JsonValue {
  const raw = typeof input === "string" ? input : stringValue(input);
  const parsed = typeof input === "string"
    ? parseJsonObject(input)
    : asObject(input);
  if (!parsed) return compactString(raw, ARG_STRING_LIMIT);

  const preferredKeys = [
    "path",
    "cwd",
    "command",
    "type",
    "action",
    "name",
    "instruction",
    "reference_id",
    "terminal_id",
    "session_id",
    "file_paths",
  ];
  const summary: Record<string, JsonValue> = {};
  for (const key of preferredKeys) {
    if (key in parsed) {
      summary[key] = safeArgumentSummaryValue(key, parsed[key]);
    }
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key in summary) continue;
    const lower = key.toLowerCase();
    if (
      lower.includes("path") || lower.includes("command") ||
      lower.includes("content") || lower.includes("contents") ||
      lower.includes("error") ||
      lower.includes("status") || lower.includes("reason") ||
      lower.includes("message") || lower === "old_str" ||
      lower === "new_str" || isSensitive(key)
    ) {
      summary[key] = safeArgumentSummaryValue(key, value);
    }
  }
  if (Object.keys(summary).length === 0) {
    return `[OBJECT:${Object.keys(parsed).length} keys]`;
  }
  return summary;
}

function toolUseFromNode(node: JsonValue): JsonObject | undefined {
  const record = asObject(node);
  if (!record) return undefined;
  return asObject(record.tool_use) ?? asObject(record.tool_use_node);
}

function summarizeToolUse(node: JsonValue): JsonValue | undefined {
  const toolUse = toolUseFromNode(node);
  if (!toolUse) return undefined;
  const input = toolUse.input_json ?? toolUse.arguments ?? toolUse.input ??
    toolUse.args;
  return {
    id: compactValue(toolUse.tool_use_id ?? toolUse.id ?? toolUse.call_id, 120),
    name: compactValue(toolUse.tool_name ?? toolUse.name, 120) || "unknown",
    args: summarizeToolArguments(input),
  };
}

function toolResultFromNode(node: JsonValue): JsonObject | undefined {
  const record = asObject(node);
  if (!record) return undefined;
  return asObject(record.tool_result_node) ?? asObject(record.tool_result);
}

function summarizeToolResult(node: JsonValue): JsonValue | undefined {
  const result = toolResultFromNode(node);
  if (!result) return undefined;
  const content = result.content ?? result.tool_result_message ??
    result.output ?? result.message;
  return {
    id: compactValue(
      result.tool_use_id ?? result.id ?? result.tool_call_id,
      120,
    ),
    name: compactValue(result.tool_name ?? result.name, 120),
    is_error: result.is_error === true || result.error === true ||
      result.tool_output_is_error === true,
    status: compactValue(result.status, 120),
    content_summary: compactValue(content, 500),
  };
}

function nodeText(node: JsonValue): string {
  const record = asObject(node);
  if (!record || toolResultFromNode(node)) return "";
  const textNode = asObject(record.text_node);
  if (textNode) return stringValue(textNode.content ?? textNode.text);
  return stringValue(record.content ?? record.text ?? record.message);
}

function summarizeNodes(value: JsonValue | undefined, limit = 10): JsonObject {
  const nodes = asArray(value);
  const texts: string[] = [];
  const toolUses: JsonValue[] = [];
  const toolResults: JsonValue[] = [];
  for (const node of nodes) {
    const text = compactString(nodeText(node), 400);
    if (text) texts.push(text);
    const use = summarizeToolUse(node);
    if (use) toolUses.push(use);
    const result = summarizeToolResult(node);
    if (result) toolResults.push(result);
  }
  return {
    count: nodes.length,
    text_nodes: texts.slice(-limit),
    tool_uses: toolUses.slice(-limit),
    tool_results: toolResults.slice(-limit),
  };
}

function summarizeHistoryRecord(item: JsonValue): JsonValue | undefined {
  const record = asObject(item);
  if (!record) return undefined;
  const requestNodes = summarizeNodes(record.request_nodes, 4);
  const responseNodes = summarizeNodes(record.response_nodes, 4);
  return {
    request_id: compactValue(record.request_id ?? record.id, 120),
    request_text: compactValue(record.request_message ?? record.message, 400),
    response_text: compactValue(record.response_text ?? record.text, 400),
    request_nodes: requestNodes,
    response_nodes: responseNodes,
  };
}

function summarizeChatHistory(value: JsonValue | undefined): JsonObject {
  const history = asArray(value);
  return {
    count: history.length,
    recent: history.slice(-6).map(summarizeHistoryRecord).filter(
      Boolean,
    ) as JsonValue[],
  };
}

function collectRecentToolErrors(body: JsonObject): JsonValue[] {
  const output: JsonValue[] = [];
  const collect = (nodes: JsonValue | undefined) => {
    for (const node of asArray(nodes)) {
      const result = summarizeToolResult(node);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        continue;
      }
      if ((result as JsonObject).is_error === true) output.push(result);
    }
  };
  for (const item of asArray(body.chat_history).slice(-8)) {
    const record = asObject(item);
    if (!record) continue;
    collect(record.request_nodes);
    collect(record.response_nodes);
  }
  collect(body.nodes);
  return output.slice(-12);
}

function currentUserText(body: JsonObject): string {
  const fromNodes = summarizeNodes(body.nodes, 4).text_nodes;
  if (Array.isArray(fromNodes) && fromNodes.length > 0) {
    return fromNodes.join("\n");
  }
  return compactValue(body.message ?? body.prompt ?? body.instruction, 800);
}

export function summarizeRequestBody(value: JsonValue | undefined): JsonValue {
  const body = asObject(value);
  if (!body) return value === undefined ? null : redact(value);

  const userGuidelines = stringValue(body.user_guidelines);
  const summary: Record<string, JsonValue> = {
    conversation_id: compactValue(body.conversation_id, 120),
    parent_conversation_id: compactValue(body.parent_conversation_id, 120),
    root_conversation_id: compactValue(body.root_conversation_id, 120),
    turn_id: compactValue(body.turn_id, 120),
    mode: compactValue(body.mode, 120),
    model: compactValue(body.model, 120),
    path: compactValue(body.path, 240),
    agent_persona_id: compactValue(body.agent_persona_id, 120),
    agent_role: inferAgentRole(userGuidelines),
    user_guidelines_summary: compactString(userGuidelines, 900),
    current_user_text: currentUserText(body),
    tool_definitions: summarizeToolDefinitions(body.tool_definitions),
    nodes: summarizeNodes(body.nodes),
    chat_history: summarizeChatHistory(body.chat_history),
    recent_tool_errors: collectRecentToolErrors(body),
  };

  for (const key of ["message", "prompt", "instruction"]) {
    if (key in body) summary[`${key}_summary`] = compactValue(body[key], 800);
  }

  return summary;
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    output[key] = isSensitive(key) ? "[REDACTED]" : value;
  }
  return output;
}

function safePath(path: string): string {
  const cleaned = path.replace(/^\/+/, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "root";
}

function dateParts(date: Date): { day: string; stamp: string } {
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), stamp: iso.replace(/[:.]/g, "-") };
}

function bodyPreviewForLog(
  ctx: RequestContext,
): { body: JsonValue; body_summary?: JsonValue } {
  if (ctx.body === undefined) return { body: null };

  const rawLength = ctx.rawBody ? ctx.rawBody.length : 0;
  const summary = summarizeRequestBody(ctx.body);
  if (rawLength > LARGE_BODY_BYTES) {
    return {
      body: `[BODY_TOO_LARGE: ${rawLength} bytes, summary recorded]`,
      body_summary: summary,
    };
  }

  let stringifiedLength = rawLength;
  if (!stringifiedLength) {
    try {
      stringifiedLength = JSON.stringify(ctx.body).length;
    } catch {
      stringifiedLength = LARGE_BODY_BYTES + 1;
    }
  }
  if (stringifiedLength > LARGE_BODY_BYTES) {
    return {
      body: `[BODY_TOO_LARGE: ${stringifiedLength} bytes, summary recorded]`,
      body_summary: summary,
    };
  }

  return { body: redact(ctx.body), body_summary: summary };
}

export async function recordRequest(
  config: ProxyConfig,
  ctx: RequestContext,
  responseKind: string,
): Promise<void> {
  if (config.logLevel === "silent") return;

  try {
    const now = new Date();
    const { day, stamp } = dateParts(now);
    const dir = `${config.requestLogDir}/${day}`;
    await Deno.mkdir(dir, { recursive: true });
    const file = `${dir}/${stamp}-${ctx.method}-${safePath(ctx.path)}.json`;
    const query: Record<string, string> = {};
    for (const [key, value] of ctx.url.searchParams.entries()) {
      query[key] = value;
    }

    const preview = bodyPreviewForLog(ctx);
    const payload = {
      requestId: ctx.requestId,
      timestamp: now.toISOString(),
      method: ctx.method,
      path: ctx.path,
      query,
      headers: headersToObject(ctx.headers),
      body: preview.body,
      ...(preview.body_summary !== undefined
        ? { body_summary: preview.body_summary }
        : {}),
      responseKind,
    };

    Deno.writeTextFile(file, JSON.stringify(payload, null, 2)).catch(() => {});
  } catch (_e) {
    // Ignore logging errors to prevent proxy crashes.
  }
}
