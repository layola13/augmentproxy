import type {
  JsonObject,
  JsonValue,
  OpenAIChatRequest,
  OpenAIMessage,
  ProxyConfig,
  RequestContext,
} from "./types.ts";
import { augmentError, jsonResponse } from "./http.ts";
import { logError, logInfo, logWarn } from "./logger.ts";

function objectBody(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
}

function text(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}


function collectReasoningFields(value: JsonObject): string[] {
  const output: string[] = [];
  for (const key of ["reasoning_content", "reasoning", "thinking", "reason"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) output.push(field.trim());
    else if (field && typeof field === "object" && !Array.isArray(field)) {
      const nested = field as JsonObject;
      const nestedText = text(nested.content ?? nested.summary ?? nested.text);
      if (nestedText.trim()) output.push(nestedText.trim());
    }
  }
  return output;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function addIfPresent(parts: string[], label: string, value: JsonValue | undefined): void {
  const rendered = text(value).trim();
  if (rendered) parts.push(`${label}:\n${rendered}`);
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head);
  return `${value.slice(0, head)}\n\n... [truncated ${value.length - maxChars} chars] ...\n\n${value.slice(value.length - tail)}`;
}

function sanitizeUpstreamText(config: ProxyConfig, value: string): string {
  if (!config.sanitizeUpstreamPrompts) return value;
  return value
    .replace(/augment\.mjs/gi, "codex-cli")
    .replace(/\bAugment\s+Code\b/gi, config.upstreamAppName)
    .replace(/\bAuggie\b/gi, config.upstreamAppName)
    .replace(/\bAugment\b/gi, config.upstreamAppName);
}

function sanitizeMessages(config: ProxyConfig, messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.map((message) => ({
    ...message,
    content: sanitizeUpstreamText(config, message.content),
  }));
}

function nodeText(node: JsonValue): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const record = node as JsonObject;
  if (record.tool_result_node) return "";
  const textNode = record.text_node;
  if (textNode && typeof textNode === "object" && !Array.isArray(textNode)) return text((textNode as JsonObject).content);
  return text(record.content);
}

function compactToolResultContent(content: string): string {
  return truncateMiddle(content, 4_000);
}

function nodeToolUse(node: JsonValue): JsonObject | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const record = node as JsonObject;
  const toolUse = record.tool_use;
  if (!toolUse || typeof toolUse !== "object" || Array.isArray(toolUse)) return undefined;
  const tool = toolUse as JsonObject;
  const name = typeof tool.tool_name === "string" ? tool.tool_name : "unknown";
  const id = typeof tool.tool_use_id === "string" ? tool.tool_use_id : `tool_${crypto.randomUUID()}`;
  const args = typeof tool.input_json === "string" ? tool.input_json : JSON.stringify(tool.input_json ?? {});
  return { id, type: "function", function: { name, arguments: args } };
}

function historyToMessages(history: JsonValue): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  for (const item of asArray(history)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;

    const requestNodes = asArray(record.request_nodes);
    const userText = requestNodes.map(nodeText).filter(Boolean).join("\n") || text(record.request_message).trim();
    if (userText) messages.push({ role: "user", content: userText });

    const responseNodes = asArray(record.response_nodes);
    const toolCalls = responseNodes.map(nodeToolUse).filter((call): call is JsonObject => Boolean(call));
    const responseText = responseNodes.map(nodeText).filter(Boolean).join("\n") || text(record.response_text).trim();
    if (responseText || toolCalls.length > 0) messages.push({ role: "assistant", content: responseText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    appendToolResultMessages(messages, requestNodes);

    if (messages.length === 0) {
      const roleRaw = text(record.role || record.speaker || record.type).toLowerCase();
      const role: "user" | "assistant" = roleRaw.includes("assistant") || roleRaw.includes("response") ? "assistant" : "user";
      const content = text(record.content || record.text || record.message).trim();
      if (content) messages.push({ role, content });
    }
  }
  return messages;
}

function appendToolResultMessages(messages: OpenAIMessage[], nodes: JsonValue): void {
  for (const node of asArray(nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const toolResult = (node as JsonObject).tool_result_node;
    if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) continue;
    const result = toolResult as JsonObject;
    const toolCallId = typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
    const content = compactToolResultContent(text(result.content));
    if (toolCallId) messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }
}

function buildMessages(config: ProxyConfig, ctx: RequestContext): OpenAIMessage[] {
  const body = objectBody(ctx);
  const systemParts: string[] = [];
  addIfPresent(systemParts, "System prompt", body.system_prompt);
  addIfPresent(systemParts, "System prompt append", body.system_prompt_append);
  addIfPresent(systemParts, "User guidelines", body.user_guidelines);
  addIfPresent(systemParts, "Workspace guidelines", body.workspace_guidelines);
  addIfPresent(systemParts, "Rules", body.rules);
  addIfPresent(systemParts, "Skills", body.skills);

  const messages: OpenAIMessage[] = [];
  if (systemParts.length > 0) messages.push({ role: "system", content: sanitizeUpstreamText(config, systemParts.join("\n\n")) });
  messages.push(...sanitizeMessages(config, historyToMessages(body.chat_history)));
  appendToolResultMessages(messages, body.nodes);

  const userParts: string[] = [];
  addIfPresent(userParts, "Message", body.message || body.prompt || body.instruction);
  addIfPresent(userParts, "Path", body.path);
  addIfPresent(userParts, "Language", body.lang || body.language);
  addIfPresent(userParts, "Selected code", body.selected_code || body.selected_text);
  addIfPresent(userParts, "Prefix", body.prefix);
  addIfPresent(userParts, "Suffix", body.suffix);
  addIfPresent(userParts, "Nodes", body.nodes);
  addIfPresent(userParts, "Blobs", body.blobs);
  addIfPresent(userParts, "User guided blobs", body.user_guided_blobs);

  const userContent = userParts.length > 0 ? userParts.join("\n\n") : "Continue.";
  messages.push({ role: "user", content: sanitizeUpstreamText(config, userContent) });
  return messages;
}


function parseToolSchema(tool: JsonObject): JsonObject {
  const schema = tool.input_schema_json;
  if (typeof schema === "string" && schema.trim()) {
    try {
      const parsed = JSON.parse(schema) as JsonObject;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return { type: "object", properties: {} };
    }
  }
  const inputSchema = tool.input_schema;
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) return inputSchema as JsonObject;
  const parameters = tool.parameters;
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) return parameters as JsonObject;
  return { type: "object", properties: {} };
}

function buildOpenAITools(ctx: RequestContext): JsonObject[] {
  const body = objectBody(ctx);
  const toolDefinitions = Array.isArray(body.tool_definitions) ? body.tool_definitions : [];
  const tools: JsonObject[] = [];
  for (const item of toolDefinitions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tool = item as JsonObject;
    if (typeof tool.name !== "string" || !tool.name) continue;
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: parseToolSchema(tool),
      },
    });
  }
  return tools;
}


function splitThinkingTags(content: string): { visible: string; thinking: string[] } {
  const thinking: string[] = [];
  let visible = content;
  const patterns = [
    /<think(?:ing)?[^>]*>([\s\S]*?)<\/think(?:ing)?>/gi,
    /<reason[^>]*>([\s\S]*?)<\/reason>/gi,
  ];
  for (const pattern of patterns) {
    visible = visible.replace(pattern, (_match, inner: string) => {
      const text = String(inner ?? "").trim();
      if (text) thinking.push(text);
      return "";
    });
  }
  return { visible: visible.trim(), thinking };
}

function thinkingNodes(thinking: string[], startingId = 1000): JsonObject[] {
  return thinking.map((content, index) => ({
    id: startingId + index,
    type: 8,
    thinking: { content },
  }));
}

function workspaceFallbackPath(ctx: RequestContext): string | undefined {
  const body = objectBody(ctx);
  if (typeof body.path === "string" && body.path) return body.path;
  return undefined;
}

function parseToolCall(call: JsonValue, fallbackPath?: string): { id: string; name: string; argumentsJson: string } | undefined {
  if (!call || typeof call !== "object" || Array.isArray(call)) return undefined;
  const record = call as JsonObject;
  const fn = record.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return undefined;
  const fnRecord = fn as JsonObject;
  const name = normalizeToolName(typeof fnRecord.name === "string" && fnRecord.name ? fnRecord.name : "unknown");
  const argumentsJson = normalizeToolArguments(name, typeof fnRecord.arguments === "string" ? fnRecord.arguments : JSON.stringify(fnRecord.arguments ?? {}), fallbackPath);
  const id = typeof record.id === "string" && record.id ? record.id : `tool_${crypto.randomUUID()}`;
  return { id, name, argumentsJson };
}

function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, string> = {
    bash: "launch-process",
    shell: "launch-process",
    run: "launch-process",
    exec: "launch-process",
    read: "view",
    "read-file": "view",
    open: "view",
    edit: "str-replace-editor",
    write: "save-file",
    "write-file": "save-file",
    search: "search-untruncated",
    grep: "search-untruncated",
    "view-tasklist": "view_tasklist",
    "reorganize-tasklist": "reorganize_tasklist",
    "update-tasks": "update_tasks",
    "add-tasks": "add_tasks",
  };
  return aliases[normalized] ?? normalized;
}

function normalizeToolArguments(toolName: string, argumentsJson: string, fallbackPath?: string): string {
  let args: JsonObject;
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    args = {};
    const pathMatch = argumentsJson.match(/(?:path|file_path|filepath|filename|file|absolute_path)\s*[:=]\s*["']?([^"'\n,}]+)["']?/i);
    if (pathMatch?.[1]) args.path = pathMatch[1].trim();
    else if (argumentsJson.trim().startsWith("/")) args.path = argumentsJson.trim();
    else if (argumentsJson.trim()) args.raw_input = argumentsJson;
  }

  if ((toolName === "view" || toolName === "view-range-untruncated") && typeof args.path !== "string") {
    const candidate = args.file_path ?? args.filepath ?? args.filename ?? args.file ?? args.absolute_path;
    if (typeof candidate === "string") args.path = candidate;
    else if (fallbackPath) args.path = fallbackPath;
  }
  if ((toolName === "launch-process") && typeof args.command !== "string") {
    const candidate = args.cmd ?? args.shell_command;
    if (typeof candidate === "string") args.command = candidate;
  }
  if ((toolName === "launch-process") && typeof args.cwd !== "string" && fallbackPath) args.cwd = fallbackPath;
  return JSON.stringify(args);
}

function toolCallsToNodes(toolCalls: JsonValue, startingId = 1, fallbackPath?: string): JsonObject[] {
  if (!Array.isArray(toolCalls)) return [];
  const nodes: JsonObject[] = [];
  let id = startingId;
  for (const call of toolCalls) {
    const parsed = parseToolCall(call, fallbackPath);
    if (!parsed) continue;
    nodes.push({
      id,
      type: 5,
      tool_use: {
        tool_name: parsed.name,
        tool_use_id: parsed.id,
        input_json: parsed.argumentsJson,
      },
    });
    id += 1;
  }
  return nodes;
}

function mergeStreamToolCalls(toolCalls: JsonObject[]): JsonObject[] {
  const byKey = new Map<string, JsonObject>();
  const order: string[] = [];

  for (const call of toolCalls) {
    const index = typeof call.index === "number" ? call.index : order.length;
    const id = typeof call.id === "string" && call.id ? call.id : undefined;
    const key = id ?? `index:${index}`;
    let merged = byKey.get(key);
    if (!merged) {
      merged = { id: id ?? `tool_${crypto.randomUUID()}`, type: "function", function: {} };
      byKey.set(key, merged);
      order.push(key);
    }

    if (id) merged.id = id;
    if (typeof call.type === "string") merged.type = call.type;

    const sourceFunction = call.function;
    if (!sourceFunction || typeof sourceFunction !== "object" || Array.isArray(sourceFunction)) continue;

    const mergedFunction = (merged.function && typeof merged.function === "object" && !Array.isArray(merged.function))
      ? merged.function as JsonObject
      : {};
    const sourceFunctionRecord = sourceFunction as JsonObject;

    if (typeof sourceFunctionRecord.name === "string" && sourceFunctionRecord.name) {
      mergedFunction.name = `${typeof mergedFunction.name === "string" ? mergedFunction.name : ""}${sourceFunctionRecord.name}`;
    }
    if (typeof sourceFunctionRecord.arguments === "string") {
      mergedFunction.arguments = `${typeof mergedFunction.arguments === "string" ? mergedFunction.arguments : ""}${sourceFunctionRecord.arguments}`;
    }
    merged.function = mergedFunction;
  }

  const mergedCalls = order.map((key) => byKey.get(key)).filter((call): call is JsonObject => {
    const fn = call?.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return false;
    const record = fn as JsonObject;
    return typeof record.name === "string" && record.name.length > 0;
  });
  return dedupeToolCalls(mergedCalls);
}

function dedupeToolCalls(toolCalls: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const output: JsonObject[] = [];
  for (const call of toolCalls) {
    const fn = call.function;
    const fnRecord = fn && typeof fn === "object" && !Array.isArray(fn) ? fn as JsonObject : {};
    const name = typeof fnRecord.name === "string" ? normalizeToolName(fnRecord.name) : "unknown";
    const args = typeof fnRecord.arguments === "string" ? fnRecord.arguments : JSON.stringify(fnRecord.arguments ?? {});
    const key = `${name}:${args}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function renderToolCalls(toolCalls: JsonValue): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls.map((call) => {
    const parsed = parseToolCall(call);
    if (!parsed) return "";
    return `<tool_call>\n<${parsed.name}>\n${parsed.argumentsJson}\n</${parsed.name}>\n</tool_call>`;
  }).filter(Boolean).join("\n");
}

function buildOpenAIRequest(config: ProxyConfig, ctx: RequestContext, stream: boolean): OpenAIChatRequest {
  const body = objectBody(ctx);
  const request: OpenAIChatRequest = {
    model: config.openaiModel,
    messages: buildMessages(config, ctx),
    stream,
  };
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.max_tokens === "number") request.max_tokens = body.max_tokens;
  const tools = buildOpenAITools(ctx);
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = "auto";
  }
  return request;
}

function openAIHeaders(config: ProxyConfig, stream: boolean): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${config.openaiApiKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  if (config.openaiUserAgent) headers.set("user-agent", config.openaiUserAgent);
  return headers;
}

function openAIUrl(config: ProxyConfig): string {
  return `${config.openaiBaseUrl}/chat/completions`;
}

function augmentStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  return status;
}

export async function forwardAugmentJson(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const request = buildOpenAIRequest(config, ctx, false);
  const fallbackPath = workspaceFallbackPath(ctx);
  logInfo(config, "openai:json:start", { requestId: ctx.requestId, model: config.openaiModel, url: openAIUrl(config) });
  logInfo(config, "openai:json:payload", { requestId: ctx.requestId, messages: request.messages.length, tools: request.tools?.length ?? 0, bytes: JSON.stringify(request).length });
  const upstream = await fetch(openAIUrl(config), {
    method: "POST",
    headers: openAIHeaders(config, false),
    body: JSON.stringify(request),
  });

  const raw = await upstream.text();
  logInfo(config, "openai:json:end", { requestId: ctx.requestId, status: upstream.status });
  if (!upstream.ok) {
    return augmentError(`OpenAI upstream failed: ${raw.slice(0, 1000)}`, augmentStatus(upstream.status), "upstream_error");
  }

  let data: JsonObject;
  try {
    data = JSON.parse(raw) as JsonObject;
  } catch {
    return augmentError("OpenAI upstream returned invalid JSON", 502, "bad_upstream_json");
  }

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0];
  let content = "";
  let nodes: JsonObject[] = [];
  let reasoningFallback = "";
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const message = (first as JsonObject).message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const messageRecord = message as JsonObject;
      content = text(messageRecord.content);
      const reasoning = collectReasoningFields(messageRecord);
      reasoningFallback = reasoning.join("\n\n").trim();
      if (reasoning.length > 0) nodes = [...thinkingNodes(reasoning), ...nodes];
      nodes = [...nodes, ...toolCallsToNodes(messageRecord.tool_calls, 1, fallbackPath)];
      if (nodes.length === 0) {
        const renderedToolCalls = renderToolCalls((message as JsonObject).tool_calls);
        if (renderedToolCalls) content = content ? `${content}\n${renderedToolCalls}` : renderedToolCalls;
      }
    }
    content ||= text((first as JsonObject).text);
  }

  const requestId = ctx.requestId;
  const split = splitThinkingTags(content);
  content = split.visible;
  if (!content && reasoningFallback && nodes.every((node) => !(node as JsonObject).tool_use)) {
    content = reasoningFallback;
    nodes = [];
  }
  nodes = [...thinkingNodes(split.thinking), ...nodes];
  return jsonResponse({
    text: content,
    response_text: content,
    completion: content,
    request_id: requestId,
    requestId,
    stop_reason: "stop",
    usage: data.usage ?? null,
    nodes,
  });
}

function sseEncode(value: JsonObject): string {
  return `${JSON.stringify(value)}\n`;
}

function renderDeltaToolCalls(toolCalls: JsonValue): string {
  return renderToolCalls(toolCalls);
}

function extractDelta(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return payload === "[DONE]" ? "" : undefined;
  try {
    const data = JSON.parse(payload) as JsonObject;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
    const delta = (first as JsonObject).delta;
    if (delta && typeof delta === "object" && !Array.isArray(delta)) {
      const content = text((delta as JsonObject).content);
      const toolText = renderDeltaToolCalls((delta as JsonObject).tool_calls);
      return content || toolText || undefined;
    }
    return text((first as JsonObject).text) || undefined;
  } catch {
    return undefined;
  }
}



class ThinkingStreamFilter {
  private mode: "visible" | "thinking" = "visible";
  private pending = "";
  private thinkingCurrent = "";
  private inlineCode = false;
  private fencedCode = false;
  readonly thinking: string[] = [];

  private consumeVisibleChar(): string {
    const char = this.pending[0];
    if (this.pending.startsWith("```")) {
      this.fencedCode = !this.fencedCode;
      this.pending = this.pending.slice(3);
      return "```";
    }
    if (!this.fencedCode && char === "`") this.inlineCode = !this.inlineCode;
    this.pending = this.pending.slice(1);
    return char;
  }

  private inCode(): boolean {
    return this.inlineCode || this.fencedCode;
  }

  push(input: string): string {
    this.pending += input;
    let visible = "";
    while (this.pending.length > 0) {
      if (this.mode === "visible") {
        if (this.inCode()) {
          visible += this.consumeVisibleChar();
          continue;
        }
        const open = this.pending.search(/<\/?(?:think|thinking|reason)\b/i);
        if (open < 0) {
          const keep = Math.min(this.pending.length, 16);
          const flushLen = Math.max(0, this.pending.length - keep);
          for (let index = 0; index < flushLen;) {
            if (this.pending.startsWith("```")) {
              visible += this.consumeVisibleChar();
              index += 3;
            } else {
              visible += this.consumeVisibleChar();
              index += 1;
            }
          }
          break;
        }
        for (let index = 0; index < open;) {
          if (this.pending.startsWith("```")) {
            visible += this.consumeVisibleChar();
            index += 3;
          } else {
            visible += this.consumeVisibleChar();
            index += 1;
          }
        }
        if (this.inCode()) continue;
        const match = this.pending.match(/^<(think|thinking|reason)\b[^>]*>/i);
        if (!match) {
          if (this.pending.length < 32) break;
          visible += this.consumeVisibleChar();
          continue;
        }
        this.pending = this.pending.slice(match[0].length);
        this.mode = "thinking";
        this.thinkingCurrent = "";
      } else {
        const close = this.pending.search(/<\/(?:think|thinking|reason)>/i);
        if (close < 0) {
          this.thinkingCurrent += this.pending;
          this.pending = "";
          break;
        }
        this.thinkingCurrent += this.pending.slice(0, close);
        const closeMatch = this.pending.slice(close).match(/^<\/(?:think|thinking|reason)>/i);
        this.pending = this.pending.slice(close + (closeMatch?.[0].length ?? 0));
        const thought = this.thinkingCurrent.trim();
        if (thought) this.thinking.push(thought);
        this.thinkingCurrent = "";
        this.mode = "visible";
      }
    }
    return visible;
  }

  flush(): { visible: string; thinking: string[] } {
    let visible = "";
    if (this.mode === "thinking") {
      const thought = (this.thinkingCurrent + this.pending).trim();
      if (thought) this.thinking.push(thought);
    } else {
      visible = this.pending;
    }
    this.pending = "";
    this.thinkingCurrent = "";
    this.mode = "visible";
    return { visible, thinking: this.thinking };
  }
}

function parseOpenAIStreamLine(line: string): { content?: string; thinking?: string[]; toolCalls?: JsonObject[]; done?: boolean; finishReason?: string } {
  if (!line.startsWith("data:")) return {};
  const payload = line.slice(5).trim();
  if (!payload) return {};
  if (payload === "[DONE]") return { done: true };
  try {
    const data = JSON.parse(payload) as JsonObject;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return {};
    const finishReason = text((first as JsonObject).finish_reason) || undefined;
    const delta = (first as JsonObject).delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) return { finishReason };
    const deltaRecord = delta as JsonObject;
    return {
      content: text(deltaRecord.content) || undefined,
      thinking: collectReasoningFields(deltaRecord),
      toolCalls: Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls as JsonObject[] : undefined,
      finishReason,
    };
  } catch {
    return {};
  }
}

export async function forwardAugmentStream(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const request = buildOpenAIRequest(config, ctx, true);
  const requestId = ctx.requestId;
  const fallbackPath = workspaceFallbackPath(ctx);
  const streamToolCalls: JsonObject[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";
      const thinkingFilter = new ThinkingStreamFilter();
      const thinkingBuffer: string[] = [];
      let visibleText = "";
      let emittedVisibleText = false;
      let sawDone = false;
      let upstreamChunks = 0;
      let upstreamContentChars = 0;
      let finishReason = "";
      let closed = false;
      const safeEnqueue = (value: JsonObject) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEncode(value)));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // stream already closed by client
        }
      };
      const heartbeat = setInterval(() => {
        safeEnqueue({ text: "", heartbeat: true, request_id: requestId });
      }, 5_000);

      // Send an immediate chunk so Augment receives response headers before its headers timeout.
      safeEnqueue({ text: "", heartbeat: true, request_id: requestId });

      void (async () => {
      try {
        let upstream: Response;
        try {
          logInfo(config, "openai:stream:start", { requestId, model: config.openaiModel, url: openAIUrl(config) });
          logInfo(config, "openai:stream:payload", { requestId, messages: request.messages.length, tools: request.tools?.length ?? 0, bytes: JSON.stringify(request).length });
          const waitLogger = setInterval(() => logInfo(config, "openai:stream:waiting-headers", { requestId }), 15_000);
          try {
            upstream = await fetch(openAIUrl(config), {
              method: "POST",
              headers: openAIHeaders(config, true),
              body: JSON.stringify(request),
            });
          } finally {
            clearInterval(waitLogger);
          }
        } catch (error) {
          logError(config, "openai:stream:fetch-error", { requestId, error: error instanceof Error ? error.message : String(error) });
          safeEnqueue({ error: `OpenAI stream request failed: ${error instanceof Error ? error.message : String(error)}`, request_id: requestId });
          finish();
          return;
        }

        logInfo(config, "openai:stream:headers", { requestId, status: upstream.status });

        if (!upstream.ok || !upstream.body) {
          const raw = await upstream.text().catch(() => "");
          logWarn(config, "openai:stream:bad-status", { requestId, status: upstream.status, body: raw.slice(0, 300) });
          safeEnqueue({ error: `OpenAI stream upstream failed: ${raw.slice(0, 1000)}`, request_id: requestId });
          finish();
          return;
        }

        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseOpenAIStreamLine(line);
            if (parsed.done) sawDone = true;
            if (parsed.finishReason) finishReason = parsed.finishReason;
            if (parsed.toolCalls?.length) streamToolCalls.push(...parsed.toolCalls);
            if (parsed.thinking?.length) thinkingBuffer.push(...parsed.thinking);
            if (parsed.content) {
              upstreamChunks += 1;
              upstreamContentChars += parsed.content.length;
              const visible = thinkingFilter.push(parsed.content);
              if (visible) {
                emittedVisibleText = true;
                visibleText += visible;
                safeEnqueue({ text: visible, delta: visible, request_id: requestId });
              }
            }
          }
        }
        const flushed = thinkingFilter.flush();
        if (flushed.visible) {
          emittedVisibleText = true;
          visibleText += flushed.visible;
          safeEnqueue({ text: flushed.visible, delta: flushed.visible, request_id: requestId });
        }
        const mergedToolCalls = mergeStreamToolCalls(streamToolCalls);
        if (streamToolCalls.length > 0) logInfo(config, "openai:stream:tool-calls", { requestId, fragments: streamToolCalls.length, merged: mergedToolCalls.length });
        const toolNodes = toolCallsToNodes(mergedToolCalls, 1, fallbackPath);
        if (toolNodes.length > 0) {
          logInfo(config, "openai:stream:tool-nodes", {
            requestId,
            nodes: toolNodes.map((node) => (node.tool_use as JsonObject | undefined)?.tool_name ?? "unknown"),
            inputs: toolNodes.map((node) => {
              const input = ((node.tool_use as JsonObject | undefined)?.input_json ?? "") as string;
              return { len: input.length, preview: input.slice(0, 120) };
            }),
            fallbackPathUsed: fallbackPath,
          });
        }
        const allThinking = [...thinkingBuffer, ...flushed.thinking].filter((item) => item.trim());
        logInfo(config, "openai:stream:end", { requestId, sawDone, finishReason, upstreamChunks, upstreamContentChars, thinkingItems: allThinking.length, toolFragments: streamToolCalls.length });
        if (!emittedVisibleText && toolNodes.length === 0 && allThinking.length > 0) {
          const fallbackText = allThinking.join("\n\n");
          logWarn(config, "openai:stream:reasoning-as-text", { requestId, chars: fallbackText.length });
          visibleText += fallbackText;
          safeEnqueue({ text: fallbackText, delta: fallbackText, request_id: requestId });
          emittedVisibleText = true;
        }
        const thoughtNodes = emittedVisibleText ? [] : thinkingNodes(allThinking);
        const finalNodes = [...thoughtNodes, ...toolNodes];
        if (!emittedVisibleText && finalNodes.length === 0) {
          logWarn(config, "openai:stream:empty-keepalive", { requestId, sawDone, finishReason, upstreamChunks, upstreamContentChars });
          safeEnqueue({ text: "", heartbeat: true, empty_upstream: true, request_id: requestId });
          return;
        }
        if (finalNodes.length > 0) safeEnqueue({ text: "", nodes: finalNodes, request_id: requestId });
        logInfo(config, "openai:stream:final", { requestId, visibleChars: visibleText.length, nodes: finalNodes.length });
        safeEnqueue({ text: visibleText, response_text: visibleText, completion: visibleText, done: true, stop_reason: "stop", request_id: requestId });
        finish();
      } catch (error) {
        logError(config, "openai:stream:error", { requestId, error: String(error) });
        safeEnqueue({ error: String(error), request_id: requestId });
        finish();
      }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
      "x-request-id": requestId,
    },
  });
}

export async function forwardCompletion(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const response = await forwardAugmentJson(config, ctx);
  if (!response.ok) return response;
  const data = await response.json() as JsonObject;
  const content = typeof data.text === "string" ? data.text : "";
  return jsonResponse({
    completion_items: [{ text: content }],
    completion: content,
    text: content,
    request_id: ctx.requestId,
  });
}
