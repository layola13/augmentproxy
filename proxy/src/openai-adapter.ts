import type {
  JsonObject,
  JsonValue,
  OpenAIChatRequest,
  OpenAIMessage,
  ProxyConfig,
  RequestContext,
} from "./types.ts";
import { augmentError, jsonResponse } from "./http.ts";

function objectBody(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
}

function text(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function addIfPresent(parts: string[], label: string, value: JsonValue | undefined): void {
  const rendered = text(value).trim();
  if (rendered) parts.push(`${label}:\n${rendered}`);
}

function nodeText(node: JsonValue): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const record = node as JsonObject;
  const textNode = record.text_node;
  if (textNode && typeof textNode === "object" && !Array.isArray(textNode)) return text((textNode as JsonObject).content);
  return text(record.content);
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

    for (const node of requestNodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const toolResult = (node as JsonObject).tool_result_node;
      if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) continue;
      const result = toolResult as JsonObject;
      const toolCallId = typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
      const content = text(result.content);
      if (toolCallId) messages.push({ role: "tool", tool_call_id: toolCallId, content });
    }

    const responseNodes = asArray(record.response_nodes);
    const toolCalls = responseNodes.map(nodeToolUse).filter((call): call is JsonObject => Boolean(call));
    const responseText = responseNodes.map(nodeText).filter(Boolean).join("\n") || text(record.response_text).trim();
    if (responseText || toolCalls.length > 0) messages.push({ role: "assistant", content: responseText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (messages.length === 0) {
      const roleRaw = text(record.role || record.speaker || record.type).toLowerCase();
      const role: "user" | "assistant" = roleRaw.includes("assistant") || roleRaw.includes("response") ? "assistant" : "user";
      const content = text(record.content || record.text || record.message).trim();
      if (content) messages.push({ role, content });
    }
  }
  return messages;
}

function buildMessages(ctx: RequestContext): OpenAIMessage[] {
  const body = objectBody(ctx);
  const systemParts: string[] = [];
  addIfPresent(systemParts, "System prompt", body.system_prompt);
  addIfPresent(systemParts, "System prompt append", body.system_prompt_append);
  addIfPresent(systemParts, "User guidelines", body.user_guidelines);
  addIfPresent(systemParts, "Workspace guidelines", body.workspace_guidelines);
  addIfPresent(systemParts, "Rules", body.rules);
  addIfPresent(systemParts, "Skills", body.skills);

  const messages: OpenAIMessage[] = [];
  if (systemParts.length > 0) messages.push({ role: "system", content: systemParts.join("\n\n") });
  messages.push(...historyToMessages(body.chat_history));

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
  messages.push({ role: "user", content: userContent });
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

function parseToolCall(call: JsonValue): { id: string; name: string; argumentsJson: string } | undefined {
  if (!call || typeof call !== "object" || Array.isArray(call)) return undefined;
  const record = call as JsonObject;
  const fn = record.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return undefined;
  const fnRecord = fn as JsonObject;
  const name = typeof fnRecord.name === "string" && fnRecord.name ? fnRecord.name : "unknown";
  const argumentsJson = typeof fnRecord.arguments === "string" ? fnRecord.arguments : JSON.stringify(fnRecord.arguments ?? {});
  const id = typeof record.id === "string" && record.id ? record.id : `tool_${crypto.randomUUID()}`;
  return { id, name, argumentsJson };
}

function toolCallsToNodes(toolCalls: JsonValue, startingId = 1): JsonObject[] {
  if (!Array.isArray(toolCalls)) return [];
  const nodes: JsonObject[] = [];
  let id = startingId;
  for (const call of toolCalls) {
    const parsed = parseToolCall(call);
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
    messages: buildMessages(ctx),
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

function openAIUrl(config: ProxyConfig): string {
  return `${config.openaiBaseUrl}/chat/completions`;
}

function augmentStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  return status;
}

export async function forwardAugmentJson(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const request = buildOpenAIRequest(config, ctx, false);
  const upstream = await fetch(openAIUrl(config), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json",
      "user-agent": config.userAgent,
    },
    body: JSON.stringify(request),
  });

  const raw = await upstream.text();
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
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const message = (first as JsonObject).message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      content = text((message as JsonObject).content);
      nodes = toolCallsToNodes((message as JsonObject).tool_calls);
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


function parseOpenAIStreamLine(line: string): { content?: string; toolCalls?: JsonObject[]; done?: boolean } {
  if (!line.startsWith("data:")) return {};
  const payload = line.slice(5).trim();
  if (!payload) return {};
  if (payload === "[DONE]") return { done: true };
  try {
    const data = JSON.parse(payload) as JsonObject;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return {};
    const delta = (first as JsonObject).delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) return {};
    return {
      content: text((delta as JsonObject).content) || undefined,
      toolCalls: Array.isArray((delta as JsonObject).tool_calls) ? (delta as JsonObject).tool_calls as JsonObject[] : undefined,
    };
  } catch {
    return {};
  }
}

export async function forwardAugmentStream(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const request = buildOpenAIRequest(config, ctx, true);
  const upstream = await fetch(openAIUrl(config), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json",
      "user-agent": config.userAgent,
    },
    body: JSON.stringify(request),
  });

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    return augmentError(`OpenAI stream upstream failed: ${raw.slice(0, 1000)}`, augmentStatus(upstream.status), "upstream_stream_error");
  }

  const requestId = ctx.requestId;
  const streamToolCalls: JsonObject[] = [];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";
      let visibleBuffer = "";
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(sseEncode({ heartbeat: true, request_id: requestId })));
      }, 10_000);
      try {
        const reader = upstream.body!.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseOpenAIStreamLine(line);
            if (parsed.toolCalls?.length) streamToolCalls.push(...parsed.toolCalls);
            if (parsed.content) {
              visibleBuffer += parsed.content;
              controller.enqueue(encoder.encode(sseEncode({ text: parsed.content, delta: parsed.content, request_id: requestId })));
            }
          }
        }
        const split = splitThinkingTags(visibleBuffer);
        const toolNodes = toolCallsToNodes(streamToolCalls);
        const thoughtNodes = thinkingNodes(split.thinking);
        const finalNodes = [...thoughtNodes, ...toolNodes];
        if (finalNodes.length > 0) controller.enqueue(encoder.encode(sseEncode({ text: "", nodes: finalNodes, request_id: requestId })));
        controller.enqueue(encoder.encode(sseEncode({ text: "", done: true, stop_reason: "stop", request_id: requestId })));
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(sseEncode({ error: String(error), request_id: requestId })));
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      }
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
