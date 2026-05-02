import { loadConfigFromEnvFile } from "./config.ts";
import {
  DEFAULT_HISTORY_PRUNE_OPTIONS,
  pruneRequestHistory,
  type HistoryPruneSummary,
} from "./history-pruning.ts";
import {
  appendEventLog,
  createRequestLogContext,
  headersToObject,
  logLine,
  writeJsonArtifact,
  writeTextArtifact,
} from "./logger.ts";
import {
  executeBridgeCall,
  extractBridgeCall,
  flattenBridgeToolsInRequest,
  isAnyFunctionCall,
  loadBridgeRegistry,
} from "./mcp-bridge.ts";
import type { JsonObject, JsonValue, McpBridgeRegistry, ProxyAnyRouterConfig } from "./types.ts";

const config = await loadConfigFromEnvFile();

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseJsonRequestBody(raw: string): JsonObject {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as JsonValue;
  return objectValue(parsed);
}

type ParsedSseEvent = {
  type: string;
  data: JsonObject;
};

type UpstreamTurn = {
  events: ParsedSseEvent[];
  responseId?: string;
  usage?: JsonObject;
  rawSse: string;
  status: number;
};

function encodeSseEvent(event: ParsedSseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

function parseSseText(rawSse: string, status = 200): UpstreamTurn {
  let buffer = rawSse;
  const events: ParsedSseEvent[] = [];
  let responseId: string | undefined;
  let usage: JsonObject | undefined;

  const flushBlock = (block: string) => {
    const trimmed = block.trim();
    if (!trimmed) return;
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!eventType || dataLines.length === 0) return;
    const data = JSON.parse(dataLines.join("\n")) as JsonObject;
    events.push({ type: eventType, data });
    const createdId = stringValue(objectValue(data.response).id);
    if (createdId) responseId = createdId;
    const responseUsage = objectValue(objectValue(data.response).usage);
    if (Object.keys(responseUsage).length > 0) usage = responseUsage;
  };

  const parts = buffer.split(/\r?\n\r?\n/);
  buffer = parts.pop() ?? "";
  for (const block of parts) flushBlock(block);
  if (buffer.trim()) flushBlock(buffer);
  return { events, responseId, usage, rawSse, status };
}

function forwardHeaders(incoming: Headers, config: ProxyAnyRouterConfig): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    const normalized = key.toLowerCase();
    if (normalized === "host" || normalized === "content-length") continue;
    if (normalized === "authorization") continue;
    headers.set(key, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  if (config.upstreamApiKey) {
    headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  } else if (incoming.get("authorization")) {
    headers.set("authorization", incoming.get("authorization")!);
  }
  return headers;
}

async function fetchUpstreamTurn(
  currentRequest: JsonObject,
  incomingHeaders: Headers,
  requestId: string,
  step: number,
  requestDir: string,
): Promise<UpstreamTurn> {
  const upstreamHeaders = forwardHeaders(incomingHeaders, config);
  await writeJsonArtifact(
    { requestId, requestDir },
    `${step.toString().padStart(2, "0")}-upstream-request.json`,
    {
      url: config.upstreamUrl,
      method: "POST",
      headers: headersToObject(upstreamHeaders),
      body: currentRequest,
    },
  );
  logLine("INFO", "proxyanyrouter:upstream:request", {
    requestId,
    step,
    url: config.upstreamUrl,
    previous_response_id: currentRequest.previous_response_id ?? null,
    tools: summarizeTools(currentRequest),
  });
  await appendEventLog(config, {
    requestId,
    stage: "upstream_request",
    step,
    previous_response_id: currentRequest.previous_response_id ?? null,
    tools: summarizeTools(currentRequest),
  });
  const upstream = await fetch(config.upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(currentRequest),
  });
  const raw = await upstream.text().catch(() => "");
  await writeTextArtifact(
    { requestId, requestDir },
    `${step.toString().padStart(2, "0")}-upstream-response.sse`,
    raw,
  );
  logLine("INFO", "proxyanyrouter:upstream:response", {
    requestId,
    step,
    status: upstream.status,
    bytes: raw.length,
  });
  await appendEventLog(config, {
    requestId,
    stage: "upstream_response",
    step,
    status: upstream.status,
    bytes: raw.length,
  });
  if (!upstream.ok) {
    throw new Error(
      `Upstream returned ${upstream.status}: ${raw.slice(0, 800) || "<empty body>"}`,
    );
  }
  return parseSseText(raw, upstream.status);
}

async function fetchUpstreamResponse(
  currentRequest: JsonObject,
  incomingHeaders: Headers,
  requestId: string,
  step: number,
  requestDir: string,
): Promise<Response> {
  const upstreamHeaders = forwardHeaders(incomingHeaders, config);
  await writeJsonArtifact(
    { requestId, requestDir },
    `${step.toString().padStart(2, "0")}-upstream-request.json`,
    {
      url: config.upstreamUrl,
      method: "POST",
      headers: headersToObject(upstreamHeaders),
      body: currentRequest,
    },
  );
  logLine("INFO", "proxyanyrouter:upstream:request", {
    requestId,
    step,
    url: config.upstreamUrl,
    previous_response_id: currentRequest.previous_response_id ?? null,
    tools: summarizeTools(currentRequest),
  });
  await appendEventLog(config, {
    requestId,
    stage: "upstream_request",
    step,
    previous_response_id: currentRequest.previous_response_id ?? null,
    tools: summarizeTools(currentRequest),
  });
  return await fetch(config.upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(currentRequest),
  });
}

function asInputList(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return [...value];
  if (value === undefined) return [];
  return [value];
}

function extractCompletedOutputItems(turn: UpstreamTurn): JsonValue[] {
  return turn.events
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => structuredClone(objectValue(event.data.item)));
}

function buildFollowUpRequest(
  previousRequest: JsonObject,
  turn: UpstreamTurn,
  outputs: JsonValue[],
): JsonObject {
  const next: JsonObject = { ...previousRequest };
  if (config.continuationMode === "previous_response_id") {
    if (!turn.responseId) {
      throw new Error("Upstream emitted bridge tool calls without response.created id.");
    }
    next.previous_response_id = turn.responseId;
    next.input = outputs;
    return next;
  }

  delete next.previous_response_id;
  next.input = [
    ...asInputList(previousRequest.input),
    ...extractCompletedOutputItems(turn),
    ...outputs,
  ];
  return next;
}

async function runBridgeLoop(
  originalRequest: JsonObject,
  incomingHeaders: Headers,
  requestId: string,
  requestDir: string,
): Promise<UpstreamTurn> {
  const registry = await loadBridgeRegistry(config.mcpConfigPath);
  return runBridgeLoopWithRegistry(
    originalRequest,
    incomingHeaders,
    requestId,
    requestDir,
    registry,
  );
}

async function runBridgeLoopWithRegistry(
  originalRequest: JsonObject,
  incomingHeaders: Headers,
  requestId: string,
  requestDir: string,
  registry: McpBridgeRegistry,
): Promise<UpstreamTurn> {
  const initialPrepared = prepareOutgoingRequest(flattenBridgeToolsInRequest(
    structuredClone(originalRequest),
    registry,
  ));
  await logHistoryPruning(requestId, initialPrepared.history, "bridge_initial");
  let currentRequest = withStreamMode(initialPrepared.request, true);

  for (let step = 0; step < config.maxBridgeSteps; step += 1) {
    const turn = await fetchUpstreamTurn(
      currentRequest,
      incomingHeaders,
      requestId,
      step + 1,
      requestDir,
    );
    const bridgeCalls = turn.events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => extractBridgeCall(event.data.item, registry))
      .filter((
        value,
      ): value is { callId: string; qualifiedName: string; argumentsJson: string } =>
        Boolean(value)
      );

    if (bridgeCalls.length === 0) return turn;

    const nonBridgeFunctionCalls = turn.events.some((event) => {
      if (event.type !== "response.output_item.done") return false;
      const item = objectValue(event.data.item);
      return isAnyFunctionCall(item) && !extractBridgeCall(item, registry);
    });
    if (nonBridgeFunctionCalls) return turn;

    const outputs: JsonValue[] = [];
    for (const call of bridgeCalls) {
      logLine("INFO", "proxyanyrouter:bridge:tool-call", {
        requestId,
        step: step + 1,
        qualifiedName: call.qualifiedName,
        callId: call.callId,
      });
      const output = await executeBridgeCall(call, registry);
      await writeJsonArtifact(
        { requestId, requestDir },
        `${(step + 1).toString().padStart(2, "0")}-bridge-output-${call.callId}.json`,
        {
          qualifiedName: call.qualifiedName,
          callId: call.callId,
          output,
        },
      );
      logLine("INFO", "proxyanyrouter:bridge:tool-result", {
        requestId,
        step: step + 1,
        qualifiedName: call.qualifiedName,
        callId: call.callId,
        bytes: output.length,
      });
      await appendEventLog(config, {
        requestId,
        stage: "bridge_tool_result",
        step: step + 1,
        qualifiedName: call.qualifiedName,
        callId: call.callId,
        bytes: output.length,
      });
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output,
      });
    }
    const prepared = prepareOutgoingRequest(
      buildFollowUpRequest(currentRequest, turn, outputs),
    );
    await logHistoryPruning(requestId, prepared.history, `bridge_step_${step + 1}`);
    currentRequest = withStreamMode(prepared.request, true);
  }

  throw new Error(`Exceeded max bridge steps (${config.maxBridgeSteps}).`);
}

function buildJsonResponse(turn: UpstreamTurn): JsonObject {
  const output: JsonValue[] = [];
  let outputText = "";
  for (const event of turn.events) {
    if (event.type === "response.output_item.done") {
      const item = objectValue(event.data.item);
      output.push(item);
      if (stringValue(item.type) === "message") {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const part of content) {
          const record = objectValue(part);
          if (stringValue(record.type) === "output_text") {
            outputText += stringValue(record.text) ?? "";
          }
        }
      }
    }
    if (event.type === "response.output_text.delta") {
      outputText += stringValue(event.data.delta) ?? "";
    }
  }
  return {
    id: turn.responseId ?? "",
    object: "response",
    output,
    output_text: outputText,
    usage: turn.usage ?? {},
  };
}

function newRequestId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `req_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
}

function summarizeTools(request: JsonObject): string[] {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return tools.map((item) => {
    const tool = objectValue(item);
    const type = stringValue(tool.type) ?? "unknown";
    const name = stringValue(tool.name) ?? "unknown";
    return `${type}:${name}`;
  });
}

function hasLocalBridgeTools(request: JsonObject, registry: McpBridgeRegistry): boolean {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return tools.some((item) => {
    const tool = objectValue(item);
    return stringValue(tool.type) === "namespace" &&
      registry.toolsByNamespace.has(stringValue(tool.name) ?? "");
  });
}

function sanitizeTool(toolValue: JsonValue): JsonValue {
  const tool = objectValue(toolValue);
  if (Object.keys(tool).length === 0) return toolValue;
  const toolType = stringValue(tool.type);
  if (toolType === "tool_search") {
    return null;
  }
  const sanitized: JsonObject = { ...tool };
  if (toolType === "web_search") {
    delete sanitized.description;
    delete sanitized.parameters;
    delete sanitized.execution;
  }
  if (Array.isArray(sanitized.tools)) {
    sanitized.tools = sanitized.tools.map((child) => sanitizeTool(child));
  }
  return sanitized;
}

function sanitizeOutgoingRequest(request: JsonObject): JsonObject {
  const sanitized: JsonObject = { ...request };
  if (Array.isArray(request.tools)) {
    sanitized.tools = request.tools
      .map((tool) => sanitizeTool(tool))
      .filter((tool): tool is Exclude<JsonValue, null> => tool !== null);
  }
  return sanitized;
}

function prepareOutgoingRequest(
  request: JsonObject,
): { request: JsonObject; history: HistoryPruneSummary } {
  const prepared = pruneRequestHistory(
    sanitizeOutgoingRequest(request),
    DEFAULT_HISTORY_PRUNE_OPTIONS,
  );
  return {
    request: prepared.request,
    history: prepared.summary,
  };
}

async function logHistoryPruning(
  requestId: string,
  history: HistoryPruneSummary,
  phase: string,
): Promise<void> {
  const bytesSaved = history.bytesBefore - history.bytesAfter;
  const itemsRemoved = history.inputCountBefore - history.inputCountAfter;
  if (
    bytesSaved <= 0 &&
    itemsRemoved <= 0 &&
    history.truncatedToolOutputCount <= 0 &&
    history.truncatedFunctionCallCount <= 0 &&
    history.droppedReasoningCount <= 0
  ) {
    return;
  }
  const payload = {
    requestId,
    stage: "history_pruned",
    phase,
    preservedFromIndex: history.preservedFromIndex,
    inputCountBefore: history.inputCountBefore,
    inputCountAfter: history.inputCountAfter,
    bytesBefore: history.bytesBefore,
    bytesAfter: history.bytesAfter,
    bytesSaved,
    itemsRemoved,
    droppedReasoningCount: history.droppedReasoningCount,
    truncatedToolOutputCount: history.truncatedToolOutputCount,
    truncatedFunctionCallCount: history.truncatedFunctionCallCount,
  };
  logLine("INFO", "proxyanyrouter:history:pruned", payload);
  await appendEventLog(config, payload);
}

function withStreamMode(request: JsonObject, stream: boolean): JsonObject {
  return {
    ...request,
    stream,
  };
}

async function passthroughUpstreamStream(
  requestBody: JsonObject,
  incomingHeaders: Headers,
  requestId: string,
  requestDir: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<UpstreamTurn> {
  const upstream = await fetchUpstreamResponse(
    requestBody,
    incomingHeaders,
    requestId,
    1,
    requestDir,
  );

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    await writeTextArtifact(
      { requestId, requestDir },
      "01-upstream-response.sse",
      raw,
    );
    logLine("INFO", "proxyanyrouter:upstream:response", {
      requestId,
      step: 1,
      status: upstream.status,
      bytes: raw.length,
    });
    await appendEventLog(config, {
      requestId,
      stage: "upstream_response",
      step: 1,
      status: upstream.status,
      bytes: raw.length,
    });
    throw new Error(
      `Upstream returned ${upstream.status}: ${raw.slice(0, 800) || "<empty body>"}`,
    );
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    const raw = await upstream.text().catch(() => "");
    await writeTextArtifact(
      { requestId, requestDir },
      "01-upstream-response.sse",
      raw,
    );
    logLine("INFO", "proxyanyrouter:upstream:response", {
      requestId,
      step: 1,
      status: upstream.status,
      bytes: raw.length,
      note: "empty_body",
    });
    await appendEventLog(config, {
      requestId,
      stage: "upstream_response",
      step: 1,
      status: upstream.status,
      bytes: raw.length,
      note: "empty_body",
    });
    return parseSseText(raw, upstream.status);
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    controller.enqueue(value);
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  const raw = chunks.join("");
  await writeTextArtifact(
    { requestId, requestDir },
    "01-upstream-response.sse",
    raw,
  );
  logLine("INFO", "proxyanyrouter:upstream:response", {
    requestId,
    step: 1,
    status: upstream.status,
    bytes: totalBytes,
  });
  await appendEventLog(config, {
    requestId,
    stage: "upstream_response",
    step: 1,
    status: upstream.status,
    bytes: totalBytes,
  });
  return parseSseText(raw, upstream.status);
}

async function handleResponsesRequest(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const ctx = await createRequestLogContext(config, requestId);
  const rawBody = await request.text();
  const body = parseJsonRequestBody(rawBody);
  const wantsJson = body.stream === false ||
    Boolean(request.headers.get("accept")?.includes("application/json"));
  const registry = await loadBridgeRegistry(config.mcpConfigPath);
  const hasBridge = hasLocalBridgeTools(body, registry);
  const clientArtifact = await writeJsonArtifact(
    ctx,
    "00-client-request.json",
    {
      method: request.method,
      url: request.url,
      headers: headersToObject(request.headers),
      body,
      rawBody,
    },
  );
  logLine("INFO", "proxyanyrouter:request:start", {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    wantsJson,
    tools: summarizeTools(body),
    artifact: clientArtifact,
  });
  await appendEventLog(config, {
    requestId,
    stage: "request_start",
    method: request.method,
    path: new URL(request.url).pathname,
    wantsJson,
    tools: summarizeTools(body),
  });

  if (wantsJson) {
    if (!hasBridge) {
      const prepared = prepareOutgoingRequest(structuredClone(body));
      await logHistoryPruning(requestId, prepared.history, "json_passthrough");
      const upstreamRequest = withStreamMode(prepared.request, false);
      const upstream = await fetchUpstreamResponse(
        upstreamRequest,
        request.headers,
        requestId,
        1,
        ctx.requestDir,
      );
      const raw = await upstream.text().catch(() => "");
      await writeTextArtifact(ctx, "01-upstream-response.json", raw);
      logLine("INFO", "proxyanyrouter:upstream:response", {
        requestId,
        step: 1,
        status: upstream.status,
        bytes: raw.length,
      });
      await appendEventLog(config, {
        requestId,
        stage: "upstream_response",
        step: 1,
        status: upstream.status,
        bytes: raw.length,
      });
      logLine("INFO", "proxyanyrouter:request:done", {
        requestId,
        mode: "json",
        bridge: false,
        status: upstream.status,
      });
      await appendEventLog(config, {
        requestId,
        stage: "request_done",
        mode: "json",
        bridge: false,
        status: upstream.status,
      });
      return new Response(raw, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ??
            "application/json; charset=utf-8",
        },
      });
    }
    const finalTurn = await runBridgeLoopWithRegistry(
      body,
      request.headers,
      requestId,
      ctx.requestDir,
      registry,
    );
    const payload = buildJsonResponse(finalTurn);
    await writeJsonArtifact(ctx, "99-client-response.json", payload);
    logLine("INFO", "proxyanyrouter:request:done", {
      requestId,
      mode: "json",
      bridge: true,
      responseId: finalTurn.responseId ?? null,
      events: finalTurn.events.length,
    });
    await appendEventLog(config, {
      requestId,
      stage: "request_done",
      mode: "json",
      bridge: true,
      responseId: finalTurn.responseId ?? null,
      events: finalTurn.events.length,
    });
    return jsonResponse(payload);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(encodeSseComment("heartbeat")));
      }, config.heartbeatMs);

      void (async () => {
        try {
          controller.enqueue(encoder.encode(encodeSseComment("connected")));
          const prepared = prepareOutgoingRequest(structuredClone(body));
          await logHistoryPruning(requestId, prepared.history, "stream_passthrough");
          const sanitizedBody = withStreamMode(prepared.request, true);
          const finalTurn = hasBridge
            ? await runBridgeLoopWithRegistry(
              body,
              request.headers,
              requestId,
              ctx.requestDir,
              registry,
            )
            : await passthroughUpstreamStream(
              sanitizedBody,
              request.headers,
              requestId,
              ctx.requestDir,
              controller,
            );
          await writeTextArtifact(
            ctx,
            "99-client-response.sse",
            hasBridge ? finalTurn.rawSse : finalTurn.rawSse || "",
          );
          if (hasBridge) {
            for (const event of finalTurn.events) {
              controller.enqueue(encoder.encode(encodeSseEvent(event)));
            }
          }
          logLine("INFO", "proxyanyrouter:request:done", {
            requestId,
            mode: "stream",
            bridge: hasBridge,
            responseId: finalTurn.responseId ?? null,
            events: finalTurn.events.length,
          });
          await appendEventLog(config, {
            requestId,
            stage: "request_done",
            mode: "stream",
            bridge: hasBridge,
            responseId: finalTurn.responseId ?? null,
            events: finalTurn.events.length,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logLine("ERROR", "proxyanyrouter:request:error", {
            requestId,
            message,
          });
          await appendEventLog(config, {
            requestId,
            stage: "request_error",
            message,
          });
          const event: ParsedSseEvent = {
            type: "error",
            data: {
              type: "error",
              error: {
                code: "proxyanyrouter_error",
                message,
              },
            },
          };
          controller.enqueue(encoder.encode(encodeSseEvent(event)));
        } finally {
          clearInterval(heartbeat);
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

console.log(`proxyanyrouter listening on http://127.0.0.1:${config.port}`);
console.log(`proxyanyrouter upstream: ${config.upstreamUrl}`);
console.log(`proxyanyrouter mcp config: ${config.mcpConfigPath}`);
console.log(`proxyanyrouter logs: ${config.logDir}`);
if (config.upstreamUrl === "http://127.0.0.1:8877/v1/responses") {
  console.log(
    "proxyanyrouter warning: using default mock upstream. Set PROXYANYROUTER_UPSTREAM_URL in proxyanyrouter/.env for a real provider.",
  );
}

Deno.serve({ port: config.port }, async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "proxyanyrouter" });
  }
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    try {
      return await handleResponsesRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({
        error: {
          code: "proxyanyrouter_error",
          message,
        },
      }, 500);
    }
  }
  return jsonResponse({
    error: {
      code: "not_found",
      message: `Unsupported path: ${url.pathname}`,
    },
  }, 404);
});
